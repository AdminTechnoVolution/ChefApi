import { type KeyObject, generateKeyPairSync, sign } from "node:crypto";
import { CompactSign } from "jose";

/**
 * A stand-in for Apple's certificate chain: a root, an intermediate and a leaf, built here so no private key has to live in the
 * repository. Its certificates carry Apple's marker extensions, so they pass every check the real chain passes, except that the
 * verifier is told to trust this root instead of Apple's.
 */

const LEAF_MARKER = "1.2.840.113635.100.6.11.1";
const INTERMEDIATE_MARKER = "1.2.840.113635.100.6.2.1";

const length = (size: number): Buffer => {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag: number, ...content: Buffer[]): Buffer => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const sequence = (...content: Buffer[]) => tlv(0x30, ...content);
const set = (...content: Buffer[]) => tlv(0x31, ...content);
const integer = (value: number) => tlv(0x02, Buffer.from([value]));
const oid = (text: string): Buffer => {
  const parts = text.split(".").map(Number);
  const bytes: number[] = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const group = [part & 0x7f];
    for (let rest = Math.floor(part / 128); rest > 0; rest = Math.floor(rest / 128)) group.unshift((rest & 0x7f) | 0x80);
    bytes.push(...group);
  }
  return tlv(0x06, Buffer.from(bytes));
};
const utf8 = (text: string) => tlv(0x0c, Buffer.from(text));
const utcTime = (date: Date) => tlv(0x17, Buffer.from(date.toISOString().replace(/^\d\d(\d\d)-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d).*$/, "$1$2$3$4$5$6Z")));
const name = (common: string) => sequence(set(sequence(oid("2.5.4.3"), utf8(common))));

const ECDSA_SHA256 = sequence(oid("1.2.840.10045.4.3.2"));

interface Extension {
  oid: string;
  critical?: boolean;
  value: Buffer;
}
const extension = ({ oid: id, critical, value }: Extension) =>
  sequence(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));

export interface CertificateOptions {
  subject: string;
  issuer: string;
  key: KeyObject;
  signer: KeyObject;
  notBefore: Date;
  notAfter: Date;
  extensions: Extension[];
}

export function certificate(options: CertificateOptions): Buffer {
  const tbs = sequence(
    tlv(0xa0, integer(2)),
    integer(1 + Math.floor(Math.random() * 100)),
    ECDSA_SHA256,
    name(options.issuer),
    sequence(utcTime(options.notBefore), utcTime(options.notAfter)),
    name(options.subject),
    options.key.export({ type: "spki", format: "der" }) as Buffer,
    tlv(0xa3, sequence(...options.extensions.map(extension))),
  );
  const signature = sign("sha256", tbs, options.signer);
  return sequence(tbs, ECDSA_SHA256, tlv(0x03, Buffer.from([0]), signature));
}

const CA = (pathLength?: number): Extension => ({
  oid: "2.5.29.19",
  critical: true,
  value: sequence(tlv(0x01, Buffer.from([0xff])), ...(pathLength === undefined ? [] : [integer(pathLength)])),
});
const marker = (id: string): Extension => ({ oid: id, value: Buffer.from([0x05, 0x00]) });

const pem = (der: Buffer) => `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----`;

export interface TestPki {
  /** Give this to the verifier as the root to trust. */
  rootPem: string;
  /** Signs [payload] as Apple would: the chain goes in the header. */
  sign(payload: unknown, options?: { header?: Record<string, unknown>; chain?: Buffer[] }): Promise<string>;
  /** The three certificates, leaf first. */
  chain: Buffer[];
}

const YEAR = 365 * 86_400_000;

/**
 * [leaf] shapes the leaf certificate: when it is valid, or whether it carries Apple's marker. [forged] makes one link of the chain
 * name the right issuer but be signed by a stranger's key, which is what a forged certificate looks like.
 */
export function testPki(leaf: { notBefore?: Date; notAfter?: Date; marker?: boolean; forged?: "leaf" | "intermediate" } = {}): TestPki {
  const keys = () => generateKeyPairSync("ec", { namedCurve: "P-256" });
  const root = keys();
  const intermediate = keys();
  const signing = keys();
  const stranger = keys();
  const notBefore = new Date(Date.UTC(2020, 0, 1));
  const notAfter = new Date(Date.UTC(2040, 0, 1));

  const rootDer = certificate({ subject: "Test Root", issuer: "Test Root", key: root.publicKey, signer: root.privateKey, notBefore, notAfter, extensions: [CA()] });
  const intermediateDer = certificate({
    subject: "Test Intermediate",
    issuer: "Test Root",
    key: intermediate.publicKey,
    signer: leaf.forged === "intermediate" ? stranger.privateKey : root.privateKey,
    notBefore,
    notAfter,
    extensions: [CA(0), marker(INTERMEDIATE_MARKER)],
  });
  const leafDer = certificate({
    subject: "Test Receipt Signing",
    issuer: "Test Intermediate",
    key: signing.publicKey,
    signer: leaf.forged === "leaf" ? stranger.privateKey : intermediate.privateKey,
    notBefore: leaf.notBefore ?? notBefore,
    notAfter: leaf.notAfter ?? new Date(notBefore.getTime() + 10 * YEAR),
    extensions: leaf.marker === false ? [] : [marker(LEAF_MARKER)],
  });
  const chain = [leafDer, intermediateDer, rootDer];

  return {
    rootPem: pem(rootDer),
    chain,
    async sign(payload, options = {}) {
      const header = { alg: "ES256", x5c: (options.chain ?? chain).map((der) => der.toString("base64")), ...options.header };
      return new CompactSign(new TextEncoder().encode(JSON.stringify(payload))).setProtectedHeader(header as never).sign(signing.privateKey);
    },
  };
}

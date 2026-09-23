import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";

// platform-api2.max.ru is issued by Russian Trusted Root CA, which Node does not trust by default:
// without it the container receives webhooks but every outgoing call fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY.
const CA_PATH = "certs/russian_trusted_root_ca.pem";
const CA_SHA256 = "D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31";

describe("deployment to MAX", () => {
  it("ships the pinned Russian Trusted Root CA with enough validity left", () => {
    const cert = new X509Certificate(readFileSync(CA_PATH));
    expect(cert.fingerprint256).toBe(CA_SHA256);
    expect(cert.subject).toContain("CN=Russian Trusted Root CA");
    expect(cert.ca).toBe(true);
    expect(Date.parse(cert.validTo)).toBeGreaterThan(Date.parse("2027-01-01"));
  });
  it("makes the Docker image trust that CA", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    expect(dockerfile).toMatch(new RegExp(`COPY .*${CA_PATH} /app/${CA_PATH}`));
    expect(dockerfile).toMatch(new RegExp(`NODE_EXTRA_CA_CERTS=/app/${CA_PATH}`));
  });
  it("passes WEBHOOK_URL into the container so subscribe can run there", () => {
    expect(readFileSync("compose.yaml", "utf8")).toMatch(/WEBHOOK_URL: \$\{WEBHOOK_URL:-\}/);
  });
});

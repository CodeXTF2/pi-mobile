// Self-signed CA + leaf certificate generation for the LAN HTTPS endpoint.
// A dedicated CA (CA:TRUE) is created once and installed on the phone; the leaf
// cert is (re)issued whenever the set of local IPs changes so the hostname the
// phone connects to (a LAN IP) always validates.

import forge from "node-forge";

const CA_ATTRS = [
  { name: "commonName", value: "Pi Mobile Local CA" },
  { name: "organizationName", value: "Pi Mobile" },
];

function randomSerial() {
  // Positive hex serial.
  return "00" + forge.util.bytesToHex(forge.random.getBytesSync(16));
}

export function createCA() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000);
  cert.setSubject(CA_ATTRS);
  cert.setIssuer(CA_ATTRS);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

// Issue a leaf cert for the given IPs/hostnames, signed by the CA.
export function issueLeaf(caCertPem, caKeyPem, { ips = [], hostnames = [] } = {}) {
  const caCert = forge.pki.certificateFromPem(caCertPem);
  const caKey = forge.pki.privateKeyFromPem(caKeyPem);

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 5 * 365 * 24 * 3600 * 1000);

  const subject = [{ name: "commonName", value: hostnames[0] || ips[0] || "pi-mobile" }];
  cert.setSubject(subject);
  cert.setIssuer(caCert.subject.attributes);

  // altNames type 7 = IP, type 2 = DNS
  const altNames = [
    ...hostnames.map((value) => ({ type: 2, value })),
    ...ips.map((ip) => ({ type: 7, ip })),
  ];

  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    {
      name: "keyUsage",
      digitalSignature: true,
      keyEncipherment: true,
      critical: true,
    },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames },
    { name: "subjectKeyIdentifier" },
  ]);

  cert.sign(caKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

// Stable signature of the SAN set so we can detect when a reissue is needed.
export function sanSignature({ ips = [], hostnames = [] }) {
  return JSON.stringify({
    ips: [...ips].sort(),
    hostnames: [...hostnames].sort(),
  });
}

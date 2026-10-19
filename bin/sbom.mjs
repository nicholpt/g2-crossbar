#!/usr/bin/env node
// Crossbar's software bill of materials, as CycloneDX JSON:
//   npm run sbom                 writes crossbar.sbom.cdx.json
//   npm run sbom -- out.json     or somewhere else
// npm's own SBOM (every package in package-lock.json, dev ones scoped
// "optional"), plus what Crossbar needs that npm doesn't install: Node.js,
// tmux, Tailscale, whisper.cpp and the Whisper model. docs/SBOM.md is the
// readable version.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const out = process.argv[2] || join(ROOT, 'crossbar.sbom.cdx.json');

// Installed by the user (Homebrew, or the setup script for the model), not by npm,
// so there's no exact version: `requires` says what Crossbar needs. "required":
// Crossbar won't run without it; "optional": a feature needs it.
const SYSTEM = [
  { type: 'platform', name: 'Node.js', requires: '>=20', scope: 'required', license: 'MIT',
    purl: 'pkg:generic/node', url: 'https://nodejs.org', use: 'runs the bridge on the Mac' },
  { type: 'application', name: 'tmux', requires: 'any', scope: 'required', license: 'ISC',
    purl: 'pkg:github/tmux/tmux', url: 'https://github.com/tmux/tmux', use: 'where the agents run; the bridge reads and types into panes' },
  { type: 'application', name: 'Tailscale', requires: 'any', scope: 'optional', license: 'BSD-3-Clause',
    purl: 'pkg:github/tailscale/tailscale', url: 'https://tailscale.com', use: 'private network between the phone and the Mac (not in home mode)' },
  { type: 'application', name: 'whisper.cpp', requires: 'any', scope: 'optional', license: 'MIT',
    purl: 'pkg:github/ggml-org/whisper.cpp', url: 'https://github.com/ggml-org/whisper.cpp', use: 'voice Ask: speech to text on the Mac (whisper-server)' },
  { type: 'machine-learning-model', name: 'ggml-small.en.bin', requires: 'this exact file (SHA-256)', scope: 'optional', license: 'MIT',
    purl: 'pkg:huggingface/ggerganov/whisper.cpp', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin',
    sha256: 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d', use: 'the Whisper small.en model voice Ask transcribes with (466 MB, downloaded by bin/setup)' },
];

const bom = JSON.parse(execFileSync('npm', ['sbom', '--sbom-format', 'cyclonedx', '--package-lock-only'], { cwd: ROOT, maxBuffer: 64 << 20 }).toString());
const app = JSON.parse(readFileSync(join(ROOT, 'app.json'), 'utf8'));
bom.metadata.component = { ...bom.metadata.component, type: 'application', name: app.name, version: app.version,
  purl: `pkg:github/nicholpt/g2-crossbar@v${app.version}` };
for (const s of SYSTEM) {
  bom.components.push({
    'bom-ref': `system:${s.name}`, type: s.type, name: s.name, scope: s.scope, description: s.use,
    properties: [{ name: 'crossbar:requires', value: s.requires }],
    licenses: [{ license: { id: s.license } }], purl: s.purl,
    ...(s.sha256 && { hashes: [{ alg: 'SHA-256', content: s.sha256 }] }),
    externalReferences: [{ type: s.sha256 ? 'distribution' : 'website', url: s.url }],
  });
  bom.dependencies?.find((d) => d.ref === bom.metadata.component['bom-ref'])?.dependsOn.push(`system:${s.name}`);
}
writeFileSync(out, `${JSON.stringify(bom, null, 2)}\n`);
console.log(`${out}: ${bom.components.length} components (CycloneDX ${bom.specVersion})`);

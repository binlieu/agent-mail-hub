import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('public/vendor', { recursive: true });
copyFileSync('node_modules/bootstrap/dist/css/bootstrap.min.css', 'public/vendor/bootstrap.min.css');
copyFileSync('node_modules/bootstrap/LICENSE', 'public/vendor/bootstrap.LICENSE');
const { z } = await import('zod');
const contracts = await import('../dist/contracts.js');
const { writeFileSync } = await import('node:fs');
const schemas = {};
for (const name of ['agentSchema', 'messageSchema', 'humanMessageSchema', 'heartbeatSchema', 'usageSchema', 'pageSchema', 'evidenceSchema', 'evidenceReviewSchema', 'handoffSchema', 'handoffUpdateSchema']) {
  schemas[name] = z.toJSONSchema(contracts[name]);
}
writeFileSync('docs/contracts.json', JSON.stringify({ version: 1, schemas }, null, 2) + '\n');

import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {deploymentSpec} from './delivery/base/spec.mjs';

const root = process.cwd();
const config = JSON.parse(await readFile(resolve(root, 'packaging.json'), 'utf8'));
const output = resolve(root, 'management/integration/deployment-spec.json');
const bytes = JSON.stringify(await deploymentSpec(root, config.artifact.specInputs), null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8') !== bytes) throw Error('Deployment specification is stale; run pnpm delivery:spec after building.');
  console.log('Deployment specification is current.');
} else {
  await mkdir(dirname(output), {recursive: true});
  await writeFile(output, bytes);
  console.log('Wrote management/integration/deployment-spec.json');
}

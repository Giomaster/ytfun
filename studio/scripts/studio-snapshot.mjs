#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StudioStore } from '../src/store.mjs';
import { exportStudioSnapshot, importStudioSnapshot } from '../src/studio-snapshot.mjs';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    source: { type: 'string' }, destination: { type: 'string' }, 'expected-state-sha256': { type: 'string' },
  } });
  let result;
  if (positionals.length === 1 && positionals[0] === 'export' && values.source && values.destination) {
    result = await exportStudioSnapshot(new StudioStore(values.source), values.destination);
  } else if (positionals.length === 1 && positionals[0] === 'import' && values.source && values.destination && values['expected-state-sha256']) {
    result = await importStudioSnapshot(values.source, values.destination, { expectedStateSha256: values['expected-state-sha256'] });
  } else throw new Error('Use export/import with absolute --source and --destination; import also needs --expected-state-sha256.');
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Snapshot operation failed.'); process.exitCode = 1;
}

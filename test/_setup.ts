// Aísla los tests del data/ real: cada corrida usa un cwd temporal limpio.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakkurin-test-'));
process.chdir(tmp);

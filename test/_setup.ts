// Aísla los tests del data/ real: cada corrida usa un cwd temporal limpio.
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hakkurin-test-'));
process.chdir(tmp);

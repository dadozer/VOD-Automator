import { Service } from 'node-windows';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

function uninstallScript(scriptPath, cb) {
  try {
    const svc = new Service({
      name: 'VOD Automator',
      script: scriptPath
    });
    svc.on('uninstall', function() {
      console.log(`Uninstall complete for ${path.basename(scriptPath)}.`);
      if (cb) cb();
    });
    svc.on('alreadyuninstalled', function() {
      if (cb) cb();
    });
    svc.on('error', function(err) {
      if (cb) cb();
    });
    if (svc.exists) {
      svc.uninstall();
    } else {
      if (cb) cb();
    }
  } catch {
    if (cb) cb();
  }
}

console.log('Uninstalling service...');
// Clean up both previous server.ts registration and dist/server.js registration
uninstallScript(path.join(projectRoot, 'server.ts'), () => {
  uninstallScript(path.join(projectRoot, 'dist/server.js'), () => {
    console.log('Service cleanup finished.');
    process.exit(0);
  });
});

// Guard against hanging event loops
setTimeout(() => {
  console.log('Service teardown timeout reached. Continuing...');
  process.exit(0);
}, 6000);

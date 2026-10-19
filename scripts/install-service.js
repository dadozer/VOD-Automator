import { Service } from 'node-windows';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Create a new service object pointing to the compiled production server
const svc = new Service({
  name: 'VOD Automator',
  description: 'Monitors Twitch channels and automatically downloads live broadcasts and chat.',
  script: path.join(projectRoot, 'dist/server.js'),
  workingDirectory: projectRoot,
  env: [{
    name: "NODE_ENV",
    value: "production"
  }]
});

// Listen for the "install" event, which indicates the
// process is available as a service.
svc.on('install', function() {
  console.log('Service installed successfully.');
  svc.start();
  console.log('Service started.');
  setTimeout(() => process.exit(0), 1000);
});

// Listen for the "alreadyinstalled" event
svc.on('alreadyinstalled', function() {
  console.log('This service is already installed.');
  console.log('Restarting service...');
  svc.restart();
  setTimeout(() => process.exit(0), 1000);
});

svc.on('error', function(error) {
  console.error('An error occurred during install:', error?.message || error);
  setTimeout(() => process.exit(1), 1000);
});

// Install the script as a service.
console.log('Installing service...');

// Workaround for a bug in node-windows@1.0.0-beta.8 that logs a debug object: 
// console.log({loc: 'winsw.js ~line 77', xml, config})
const originalLog = console.log;
console.log = function(...args) {
  if (args[0] && typeof args[0] === 'object' && args[0].loc === 'winsw.js ~line 77') {
    return;
  }
  originalLog.apply(console, args);
};

svc.install();

// Safety fallback timeout to exit script if node-windows holds handles
setTimeout(() => {
  console.log('Service install script completed.');
  process.exit(0);
}, 10000);

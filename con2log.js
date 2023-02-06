const moment = require('moment')
const fs = require('fs');
const path = require('path');
const util= require('util');

let oldConsoleLog = console.log;
let logStream, logDate;

exports.keepFilesDays = 40;

//--------------------------------------------------------------------------------------
process.on('uncaughtException', function(err) {
  console.log('UNHANDLED EXCEPTION:', err);
})

//--------------------------------------------------------------------------------------
console.log = function() {

  let today = moment().format('YYYY-MM-DD');

  if(logStream && logDate != today) {
    logStream.end();
    logStream = null;
  }

  if(!logStream) {

    if (!fs.existsSync('logs')) {
      fs.mkdirSync('logs')
    }

    deleteOldFiles('./logs/', exports.keepFilesDays);

    logDate = today;
    logStream = fs.createWriteStream(`logs/${logDate}.log`, { flags: 'a' });
  }

  let stamp = moment().format('YYYY-MM-DD HH:mm:ss');

  let txt = util.format.apply(null, arguments);

  oldConsoleLog(stamp + ' ' + txt);

  logStream.write(stamp + ' ' + txt + `\n`);
};

//--------------------------------------------------------------------------------------
console.error = function() {

  let txt = util.format.apply(null, arguments);

  console.log('ERROR: ' + txt);
}

//--------------------------------------------------------------------------------------
function deleteOldFiles(dir, days) {
    walkDir(dir, function(filePath) {
      fs.stat(filePath, function(err, stat) {
        var now = new Date().getTime();
        var endTime = new Date(stat.mtime).getTime() + 86400000 * days; // 1 days in miliseconds

        if (err) { 
          return console.error(err); 
        }

        if (now > endTime) {
          fs.unlink(filePath, function(err) {
            if (err) {
              return console.error(err);
            }
          });
        }
      })  
  });
}

//--------------------------------------------------------------------------------------
function walkDir(dir, callback) {
  fs.readdirSync(dir).forEach( f => {
    let dirPath = path.join(dir, f);
    let isDirectory = fs.statSync(dirPath).isDirectory();
    isDirectory ? 
      walkDir(dirPath, callback) : callback(path.join(dir, f));
  });
};

console.log('*** PROCESS START ***');
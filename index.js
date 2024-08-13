const fs = require('fs');
const http = require('http');
const express = require('express')
const moment = require('moment')
const axios = require('axios')
const _  = require('underscore');
const {parse} = require('csv-parse/sync');

const api = require('./npm-vwconnectapi');

const Con2log = require('./con2log.js');
Con2log.keepFilesDays = 7;

const app = express()

let Config;
let vwConn;
let clients = {};
let server;
let activeCommands = {};
let rawState, currentState, lastState;

let updateTimeout;
let lastABRPdoc, lastLogData, lastPollingInterval;
let retrySecs = 10;
let CarOfflineMsgSent = true;
let timedClimatisationRetry = 0, timedChargingRetry = 0;
let startingTimedClimatisation = false, startingTimedCharging = false;;
let chargingState = 0, maxKw = 0, startingPercent = 0, chargingStart;
let supressMsgTimeout;
let stats = {cycles:0};

let ClientConfig = {
  chargeLimit: 100,
  chargingAt: false,
  chargingAtH: 20,
  chargingAtM: 0,
  climatisationAt: false,
  climatisationAtH: 7,
  climatisationAtM: 0,
  climatisationtMo: true,
  climatisationtTu: true,
  climatisationtWe: true,
  climatisationtTh: true,
  climatisationtFr: true,
  climatisationtSa: false,
  climatisationtSu: false
};

//-------------------------------------------------------------------------------------------
function readCSV(inputPath) {

  let data = fs.readFileSync(inputPath);
  let records;

  records = parse(data, {
    delimiter: ';',
    relax_column_count: true
  });

  return records
}

//-------------------------------------------------------------------------------------------
function loadData() {

  let lastSoc = -1, cycles = 0;

  let files = fs.readdirSync("data");
  
  for(let file of files) {

    if(file.slice(-4) != '.csv') {
      continue;
    }

    let data = readCSV(`data/${file}`);

    for(let i = 1; i < data.length; i++) {
      let line = data[i];
      let soc = line[2];

      if(lastSoc > soc) {
        stats.cycles += (soc - lastSoc) / -100;
      }

      lastSoc = soc;
    }
  };

  console.log(`battery cycles: ${stats.cycles}`);
}

//-------------------------------------------------------------------------------------------
function sendCurrentData(socket, newData) {

  currentState.activeCommands = activeCommands;
  currentState.Config = ClientConfig;
  currentState.newData = newData;
  currentState.stats = stats;
  
  socket.emit('data', currentState);
}

//-------------------------------------------------------------------------------------------
function cleanActiveCommands() {

  // check if active command timed out
  for(let key in activeCommands) {
    
    let command = activeCommands[key];
    let seconds = moment.utc().diff(command.stamp, 'seconds');

    if(seconds >= Config.command_timeout_secs) {

      if(key == 'climatisation' && command.state == "start" && Config.telegram_failed_climatisation) {
        let climState = currentState.climatisation.data.climatisationStatus.climatisationState;

        if(climState == "off") {
          sendTelegram(`Climatisation failed!`);
        }
      }
    
      delete activeCommands[key];
    }
  }

}

//-------------------------------------------------------------------------------------------
async function sendData2abrp() {

  if(!Config['abrp_user_token'] || !Config.abrp_user_token.length) {
    return;
  }

  let data = currentState;

  let stamp = moment.utc(data.charging.status.battery.carCapturedTimestamp).unix();

  // https://documenter.getpostman.com/view/7396339/SWTK5a8w#fdb20525-51da-4195-8138-54deabe907d5
  let doc = {
    "utc": stamp,
    "soc": data.charging.status.battery.currentSOC_pct,
    "est_battery_range": data.charging.status.battery.cruisingRangeElectric_km,
    "is_charging":  data.charging.status.charging.chargePower_kW ? 1 : 0,
    "power": data.charging.status.charging.chargePower_kW,
    "car_model":"cupra:born:21:58:meb"  // https://api.iternio.com/1/tlm/get_carmodels_list?
  };

  if(data.charging?.status?.charging?.chargePower_kW) {
    doc.is_dcfc = data.charging.status.charging.chargeType == "dc";
  }

  if(data.parkingposition?.lat) {
    doc.lat = data.parkingposition.lat;
    doc.lon = data.parkingposition.lon;
    doc.speed = 0;
  } 

  if(data.status2?.engine) {
    doc.is_parked = data.status2.engine == "off";
  }

  if(data.mileage?.mileageKm) {
    doc.odometer = data.mileage.mileageKm;
  }

  doc = JSON.stringify(doc);

  if(doc == lastABRPdoc) {
    return;
  }

  let url = `https://api.iternio.com/1/tlm/send?token=${Config.abrp_user_token}&api_key=${Config.abrp_api_key}&tlm=${encodeURIComponent(doc)}`;

  try {
    let res = await axios.get(url);
    lastABRPdoc = doc;
    console.log(`sendData2abrp ${doc} ${JSON.stringify(res.data)}`);
  } catch(e) {
    console.log(`Error sending 2 abrp ${doc} ${e}`);
  }

}

//-------------------------------------------------------------------------------------------
let doCommandPromise = Promise.resolve();

function doCommand(data) {

  return new Promise((resolve, reject) => {

    let key;

    doCommandPromise = doCommandPromise.then( async () => {

      if(data.path) {
        console.log(`postSettings ${data.version} ${data.path} ${JSON.stringify(data.body)}...`);
        await vwConn.postSettings(data.version, currentState.vin, data.path, data.body);
        key = data.path;
      } else {
        console.log(`doCommand ${data.version} ${data.action} ${data.state} ${JSON.stringify(data.body)}...`);
        await vwConn.setSeatCupraStatus(data.version, currentState.vin, data.action, data.state, data.body);
        key = data.action;
      }


    }).then(()=>{

      if(data.state === "settings") {
        key += '_' + data.state;
      }
    
      activeCommands[key] = {
        "stamp": moment().utc(),
        "state": data.state,
        "body" : data.body
      };
    
      if(data.action == "climatisation" && data.state == "stop") {
        // cancel climatisation extension
        ClientConfig.climatisationExtend = false;
        saveClientConfig();
      }
    
      resolve(true);

    }).catch( (e) => {
      if(data.path) {
        console.error(`postSettings postSettings() failed ${data.path} ${JSON.stringify(data.body)}...${e}`);
      } else {
        console.error(`doCommand setSeatCupraStatus() failed ${data.action} ${data.state}...${e}`);
      }

      sendProblem2clients(`Command failed!`);
      resolve(false);
    })

  });
}

//-------------------------------------------------------------------------------------------
async function requestUpdate() {

  if(!updateTimeout) {
    console.log('requestUpdate...update in progress');
    return;
  }

  console.log('requestUpdate...');

  clearTimeout(updateTimeout);
  updateTimeout = null;

  doUpdate();
}

//-------------------------------------------------------------------------------------------
function startServer() {
  server = http.createServer(app);

  // Pass a http.Server instance to the listen method
  const io = require('socket.io')(server);

  // The server should start listening
  server.listen(Config.port);
  console.log(`listening on port ${Config.port}`);

  //-------------------------------------------------------------------------------------------
  app.get(Config.index_path, function (req, res) {
      res.sendFile(__dirname + '/web/index.html');
  });

  app.get(Config.widget_path, function (req, res) {
    res.sendFile(__dirname + '/web/widget.html');
  });

  //-------------------------------------------------------------------------------------------
  app.use('/static', express.static('public'));

  //-------------------------------------------------------------------------------------------
  app.get('/execute.cmd', async function (req, res) {

    if(req.query.key != Config.api_key) {
      res.send('-ERROR');
      return;
    }

    let data = {
      version: req.query.version,
      action: req.query.action,
      state: req.query.state,
      path: req.query.path
    }

    if(await doCommand(data)) {

      if(req.query.supressMsg == 'true') {
        if(supressMsgTimeout) {
          clearTimeout(supressMsgTimeout);
        }
        supressMsgTimeout = setTimeout(function() {
          supressMsgTimeout = null;
        }, 300000);
      }

      res.send('+OK');
    } else {
      res.send('-ERROR');
    }
  });

  //-------------------------------------------------------------------------------------------
  app.get('/data', async function (req, res) {

    if(req.query.key != Config.api_key) {
      res.send('-ERROR');
      return;
    }

    res.send(currentState);
  });

  //-------------------------------------------------------------------------------------------
  // Handle connection
  io.on('connection', function (socket) {

    console.log('connected');
    clients[socket.id] = socket;

    //-------------------------------------------------------------------------------------------
    socket.on('disconnect', function () {
      console.log('disconnect');
      delete clients[socket.id];
    });

    //-------------------------------------------------------------------------------------------
    socket.on('command', async function(data) {
      await doCommand(data);
      sendCurrentData(socket);
      storeData();
    });

    //-------------------------------------------------------------------------------------------
    socket.on('update', async function() {
      requestUpdate();
    });

    //-------------------------------------------------------------------------------------------
    socket.on('set_config', async function(config) {
      ClientConfig = config;
      saveClientConfig();
      console.log('set_config', ClientConfig);
      onNewData();
    });
    
    //-------------------------------------------------------------------------------------------
    socket.on('log', async function(text) {
      console.log(`CLIENT: ${text}`);

      fs.writeFileSync(`data/dump${moment().format('YYYYMMDDHHmmss')}_c.json`, JSON.stringify(currentState, null, 2), 'utf8');
      fs.writeFileSync(`data/dump${moment().format('YYYYMMDDHHmmss')}_r.json`, JSON.stringify(rawState, null, 2), 'utf8');
    });

    //-------------------------------------------------------------------------------------------
    socket.on('dump', async function(text) {
      console.log(`dump`);
      fs.writeFileSync(`data/dump${moment().format('YYYYMMDDHHmmss')}_c.json`, JSON.stringify(currentState, null, 2), 'utf8');
      fs.writeFileSync(`data/dump${moment().format('YYYYMMDDHHmmss')}_r.json`, JSON.stringify(rawState, null, 2), 'utf8');
    });

    //-------------------------------------------------------------------------------------------
    sendCurrentData(socket);
    requestUpdate();
  });

}

//----------------------------------------------------------------------------------------------------------------
// get token from BotFather bot
// get chat_id (=your id) with https://api.telegram.org/bot1...7287:A...ZOuO-WQ/getUpdates after sending a message from you
async function sendTelegram(text) {

  if(!Config['telegram_token']) {
    return;
  }

	let data = { 
    'parse_mode': 'HTML', 
    'text' : text
  };

	let url = "https://api.telegram.org/bot" + Config.telegram_token + "/sendMessage?chat_id=" + Config.telegram_chat_id;

  try {
    let res = await axios.post(url, data);

    if(res.statusCode >= 400) {
      console.log('ERROR: sendTelegram ' + JSON.stringify(res));
    }
  
  } catch(e) {
    console.log('ERROR: sendTelegram ' + JSON.stringify(e));
  }
}

//-------------------------------------------------------------------------------------------
function sendProblem2clients(problem) {
  // send data to clients
  for(let key in clients) {
    let socket = clients[key];
    socket.emit('problem', problem);
  }
}

//-------------------------------------------------------------------------------------------
function storeData() {

  if(!Config.store_data) {
    return;
  }

  let data = currentState;

  let carStamp = moment.utc(data.charging.status.battery.carCapturedTimestamp);
  let stamp = carStamp.unix();

  let now = moment();

  let logData = 
      ';' + data.charging.status.battery.currentSOC_pct
    + ';' + data.charging.status.charging.chargeType
    + ';' + data.charging.status.charging.chargePower_kW.toFixed(1).replace('.', ',')
    + ';' + data.charging.status.plug.plugConnectionState
    + ';' + data.charging.status.plug.plugLockState
    + ';' + data.charging.status.plug.externalPower
    + ';' + (activeCommands['charging'] ? activeCommands['charging'].state : '')
    + ';' + data.charging_settings.settings.maxChargeCurrentAC
    + ';' + data.charging_settings.settings.targetSoc_pct
    + ';' + data.climatisation.data.climatisationStatus.climatisationState
    + ';' + data.climatisation.data.climatisationStatus.remainingClimatisationTime_min
    + ';' + (data.climatisation_settings.targetTemperatureInCelsius).toFixed(1).replace('.', ',')
    + ';' + (activeCommands['climatisation'] ? activeCommands['climatisation'].state : '')
    + ';' + data.climatisation.data.windowHeatingStatus.windowHeatingStatus[0].windowHeatingState
    + ';' + data.climatisation.data.windowHeatingStatus.windowHeatingStatus[1].windowHeatingState
    + ';' + data.mileage.mileageKm
    + ';' + data.parkingposition.lat
    + ';' + data.parkingposition.lon
    + ';' + data.status2.locked + ';' + data.status2.lights + ';' + data.status2.engine + ';' + data.status2.hood.open
    + ';' + data.status2.trunk.open + ';' + data.status2.trunk.locked
    + ';' + data.status2.doors.frontLeft.open + ';' + data.status2.doors.frontLeft.locked
    + ';' + data.status2.doors.frontRight.open + ';' + data.status2.doors.frontRight.locked
    + ';' + data.status2.windows.frontLeft + ';' + data.status2.windows.frontRight + ';' + data.status2.windows.rearLeft + ';' + data.status2.windows.rearRight
    + ';' + data.vin
    + '\n';
  
  if(logData === lastLogData) {
    return;
  }

  lastLogData = logData;

  logData = now.format('YYYY-MM-DD HH:mm:ss') + ';' + carStamp.format('YYYY-MM-DD HH:mm:ss') + logData;

  if (!fs.existsSync('data')) {
    fs.mkdirSync('data')
  }

  let filename = 'data/' + now.format('YYYY-MM') + '.csv';

  if(!fs.existsSync(filename)) {
    logData = 'stamp;stamp car;soc;charging;kW;connected;plug locked;external power;charging cmd;AC current;target soc;climatisation;remaining mins;temp;climatisation cmd;window heating front;window heating back;km;lat;lon' 
      + `;locked;lights;engine;hood;trunk_open;trunk_locked;door_fl_open;door_fl_locked;door_fr_open;door_fr_locked;window_fl;window_fr;window_rl;window_rr;vin\n`
      + logData;
  }

  fs.appendFile(filename, logData, err => {
    if (err) {
      console.log('Cant write data!', err);
    }
  });

}

function chargingStopMessage(msg, telegram) {

  let chargedPercent = maxKw ? currentState.charging.status.battery.currentSOC_pct - startingPercent : 0;
  let chargedkWh = chargedPercent ? parseFloat(Config.battery_kwh) * chargedPercent / 100 : 0;
  let hours = chargingStart ? moment().diff(chargingStart, 'h', true) : 0;
  let avgkW = hours ? chargedkWh / hours : 0;

  console.log(`${msg}, charged: ${chargedPercent} %, ${chargedkWh} kWh, max: ${maxKw} kW, avg: ${avgkW} kW`);

  if(Config.telegram_external_power_errors && !supressMsgTimeout) {
    sendTelegram(`${msg}, charged: ${startingPercent}-${currentState.charging.status.battery.currentSOC_pct}%, ${chargedkWh.toFixed(1)} kWh, max: ${maxKw.toFixed(1)}kW, avg: ${avgkW.toFixed(1)} kW`);
  }

}

//-------------------------------------------------------------------------------------------
async function onNewData() {

  console.log('onNewData...');

  if(!server) {
    startServer();
  }

//  fs.writeFileSync(`data/dump${moment().format('YYYYMMDDHHmmss')}.json`, JSON.stringify(currentState, null, 2), 'utf8');

  // repair data from server
  let desired = {
    charging: {
      status: {
        battery: {
          currentSOC_pct: 0
        },
        charging: {
          chargePower_kW: 0
        },
        plug : {
          plugConnectionState: 'unknown',
          externalPower: 'unknwon',
          plugLockState: 'unknown'
        }
      }
    },
    climatisation: {
      data: {
        climatisationStatus: {
          climatisationState: "unknown",
          carCapturedTimestamp: 0
        },
        windowHeatingStatus: {
          windowHeatingStatus: [{
            windowHeatingState: false
          }, {
            windowHeatingState: false
          }]
        }
      }
    },
    services: {
      charging: {
        targetPct: 0
      }
    },
    climatisation_settings : {
      settings: {
      }
    },
    charging_settings: {
      settings: {
      }
    },
    status: {
      services: {
        charging: {
          remainingTime: 0,
          targetPct: 0
        }
      }
    },
    parkingposition: {
      lat: 0,
      lon: 0
    },
    status2: {
      "locked": null,
      "lights": null,
      "engine": null,
      "hood": {
        "open": null
      },
      "trunk": {
        "open": null,
        "locked": null
      },
      "doors": {
        "frontLeft": {
          "open": null,
          "locked": null
        },
        "frontRight": {
          "open": null,
          "locked": null,
        }
      },
      "windows": {
        "frontLeft": null,
        "frontRight": null,
        "rearLeft": null,
        "rearRight": null
      }
    },
    mileage: {
      mileageKm: null
    }
  }

  currentState = structuredClone(vwConn.vehicles[0]);
  rawState     = structuredClone(vwConn.vehicles[0]);

  if(!currentState.charging) {currentState.charging = desired.charging}
  if(!currentState.climatisation) {currentState.climatisation = desired.climatisation}
  if(!currentState.services) {currentState.services = desired.services}
  if(!currentState.climatisation_settings) {currentState.climatisation_settings = desired.climatisation_settings}
  if(!currentState.status) {currentState.status = desired.status}
  if(!currentState.parkingposition) {currentState.parkingposition = desired.parkingposition}
  if(!currentState.mileage) {currentState.mileage = desired.mileage}

  // count stats
  if(lastState) {

    if(lastState.charging.status.battery.currentSOC_pct > currentState.charging.status.battery.currentSOC_pct) {
      stats.cycles += (currentState.charging.status.battery.currentSOC_pct - lastState.charging.status.battery.currentSOC_pct) / -100;
    }
  }

  // send data to clients
  for(let key in clients) {
    let socket = clients[key];
    sendCurrentData(socket, true);
  }
  
  // check and send charging notifications
  if(currentState.charging.status.plug.plugConnectionState == 'connected') {
  
    if(currentState.charging.status.plug.externalPower == 'unavailable') {

      if(chargingState != -1) {

        if(chargingState != 2) {
          maxKw = 0;
          startingPercent = currentState.charging.status.battery.currentSOC_pct;
          chargingStart = 0;
        }

        chargingState = -1;
        chargingStopMessage('No external power', Config.telegram_external_power_errors);

        maxKw = 0;
        chargingStart = 0;
      }
    } else {

      let kw = currentState.charging.status.charging.chargePower_kW;

      if(kw) {

        if(chargingState != 2) {

          chargingState = 2;
          maxKw = kw;
          startingPercent = currentState.charging.status.battery.currentSOC_pct;
          chargingStart = moment.utc(currentState.charging.status.battery.carCapturedTimestamp);
      
          console.log(`Charging started ${kw} kW, ${chargingStart}`);
        }

        maxKw = Math.max(maxKw, kw);

      } else {

        if(chargingState == -1) {
          console.log(`external power on`);
        }

        if(chargingState == 2) {
          chargingStopMessage('Charging stopped', Config.telegram_charging_stopped);
        }

        chargingState = 1;
        maxKw = 0;
        chargingStart = 0;
      }
    }

  } else {

    if(chargingState != 0) {

      if(maxKw) {

        chargingStopMessage('Unplugged', Config.telegram_charging_stopped);
        
        maxKw = 0;
        chargingStart = 0;
      }

      chargingState = 0;
      console.log(`unplugged`);
    }
  }

  lastState = currentState;

  // keep cimate on
  let stamp = moment.utc(currentState.climatisation.data.climatisationStatus.carCapturedTimestamp);
  let age = moment().diff(stamp, 'minutes');

  let remaining = Math.max(0, currentState.climatisation.data.climatisationStatus.remainingClimatisationTime_min - age);
  let climState = currentState.climatisation.data.climatisationStatus.climatisationState;

  if(remaining || climState != 'off') {

    console.log(`climatisation ${climState} ${remaining} min, keep on:${ClientConfig.climatisationExtend}`);

  } else {

    if(activeCommands['climatisation'] && activeCommands['climatisation'].state == 'start') {

      console.log('climatisation starting');

    } else if(ClientConfig.climatisationExtend) {

      if(currentState.charging.status.battery.currentSOC_pct <= 20) {

        console.log(`climatisation extension stopped, SOC ${currentState.charging.status.battery.currentSOC_pct}%`);

        ClientConfig.climatisationExtend = false;
        saveClientConfig();

      } else if(currentState.status2.engine == "on") {

        console.log(`climatisation extension suspended, engine on`);

      } else if("home" in Config && 
                Math.abs(currentState.parkingposition.lat - Config.home.lat) <= 0.002 && 
                Math.abs(currentState.parkingposition.lon - Config.home.lon) <= 0.002) {

        console.log(`climatisation extension stopped, parking postion = home`);

        ClientConfig.climatisationExtend = false;
        saveClientConfig();
          
      } else {

        console.log('climatisation start extension');

        if(await doCommand({version: 'v1', action: 'climatisation', state: 'start'})) {
          onNewData();
          return;
        }
      }
    }
  }

  // check charge limit
  if(ClientConfig.chargeLimit < 100 && 
     currentState.charging.status.battery.currentSOC_pct >= ClientConfig.chargeLimit && 
     currentState.charging.status.charging.chargePower_kW > 0) {

    if(!activeCommands['charging'] || activeCommands['charging'].state != 'stop') {
      console.log('charging limit reached, stopping charging ' + currentState.charging.status.battery.currentSOC_pct + '>=' + ClientConfig.chargeLimit);

      if(Config['charing_limit_reached_url']) {
        try {
          let res = await axios.get(Config.charing_limit_reached_url);
          console.log('Fetched charing_limit_reached_url', Config.charing_limit_reached_url, res.status);
        } catch(e) {
          console.log('ERROR: fetching charing_limit_reached_url', Config.charing_limit_reached_url, e);
        }
      }

      await doCommand({action: 'charging', state: 'stop'});
    }

    ClientConfig.chargeLimit = 100;
    onNewData();
    return;
  }

  sendData2abrp();
  storeData();

//  fs.writeFileSync('data/dump.json', JSON.stringify(currentState, null, 2), 'utf8');

  if(updateTimeout) {
    return;
  }

  let secs = Config.refresh_secs;

  // slow polling when not needed
  if(!ClientConfig.climatisationExtend && !Object.keys(clients).length && !Object.keys(activeCommands).length && (ClientConfig.chargeLimit == 100 || currentState.charging.status.charging.chargePower_kW == 0) ) {

    let data = currentState;
    let stamp = moment.utc(data.charging.status.battery.carCapturedTimestamp);
    let age = moment().diff(stamp, 's');
    
    if(age >= Config.slow_refresh_age_secs) {
      secs = Config.slow_refresh_secs;
    } else {
      secs = Config.drive_refresh_secs;
    }

    console.log(`data age is ${age} secs`);
  }

  if(secs != lastPollingInterval) {

    if(Config.telegram_on_wakeup && 
      lastPollingInterval == Config.slow_refresh_secs && 
      secs == Config.drive_refresh_secs && 
      currentState.charging.status.plug.plugConnectionState != 'connected') {
      sendTelegram('car woke up');
    }

    lastPollingInterval = secs;
    console.log(`now polling in ${secs} secs`);
  }

  console.log('onNewData...startNextUpdate');

  startNextUpdate(secs);
}

//-------------------------------------------------------------------------------------------
async function doUpdate() {

  console.log('doUpdate...');  

  updateTimeout = null;

  if(await vwConn.update()) {
    console.log('doUpdate...ok');  

    if(CarOfflineMsgSent && Config.telegram_on_online) {
      sendTelegram('car online.');
    }
    
    CarOfflineMsgSent = false;

    retrySecs = 10;
    return;
  }

  console.log(`retry in ${retrySecs} secs...`);
  
  sendProblem2clients('Server Offline!');

  startNextUpdate(retrySecs);

  if(retrySecs < 320) {

    if(retrySecs == 160 && Config.telegram_on_offline) {
      CarOfflineMsgSent = true;
      sendTelegram('car offline!');
    }

    retrySecs *= 2;
  }
}

//-------------------------------------------------------------------------------------------
function startNextUpdate(secs) {
  updateTimeout = setTimeout(doUpdate, secs * 1000);
}

//-------------------------------------------------------------------------------------------
function loadConfig() {
  const data = fs.readFileSync('./config.json', 'utf8');
  Config = JSON.parse(data);  
}

//-------------------------------------------------------------------------------------------
function loadClientConfig() {
  try {
    const data = fs.readFileSync('./client_config.json', 'utf8');
    ClientConfig = JSON.parse(data);  
  } catch(e) {
    console.log(`Error loading client config ${e.message}`);
  }
}

//-------------------------------------------------------------------------------------------
function saveClientConfig() {
  fs.writeFileSync('./client_config.json', JSON.stringify(ClientConfig, null, 2), 'utf8');
}

//-------------------------------------------------------------------------------------------
// 1 sec
async function onTimer() {

  cleanActiveCommands();
  checkTimedClimatisation();
  checkTimedCharging();
}

//-------------------------------------------------------------------------------------------
async function checkTimedClimatisation() {

  if(startingTimedClimatisation) {
    return;
  }

  if(!timedClimatisationRetry) {
    
    if(!ClientConfig.climatisationAt) {
      return;
    }
  
    let now = moment();
  
    if(now.hours()   != ClientConfig.climatisationAtH ||
       now.minutes() != ClientConfig.climatisationAtM    ) {
  
      return;
    }
  
    if(!ClientConfig.climatisationOnce) {
      if(now.day() == 0 && !ClientConfig.climatisationSu) return;
      if(now.day() == 1 && !ClientConfig.climatisationMo) return;
      if(now.day() == 2 && !ClientConfig.climatisationTu) return;
      if(now.day() == 3 && !ClientConfig.climatisationWe) return;
      if(now.day() == 4 && !ClientConfig.climatisationTh) return;
      if(now.day() == 5 && !ClientConfig.climatisationFr) return;
      if(now.day() == 6 && !ClientConfig.climatisationSa) return;
    }

    timedClimatisationRetry = 600;  // try it 10 min

  } else {
    timedClimatisationRetry --;
  }


  if(activeCommands['climatisation'] && activeCommands['climatisation'].state  == 'start') {
    return;
  }

  let state = currentState.climatisation.data.climatisationStatus.climatisationState;

  if(state != 'off' && state != 'invalid') {
    return;
  }

  console.log(`Starting scheduled climatisation retry[secs]:${timedClimatisationRetry} state=${state} climatisationAt=${ClientConfig.climatisationAt}`);

  if(ClientConfig.climatisationOnce && ClientConfig.climatisationAt) {
    ClientConfig.climatisationAt = false;
    saveClientConfig();
  }

  startingTimedClimatisation = true;

  await doCommand({version: 'v1', action: 'climatisation', state: 'start'});

  startingTimedClimatisation = false;
}

//-------------------------------------------------------------------------------------------
async function checkTimedCharging() {

  if(startingTimedCharging) {
    return;
  }

  if(!timedChargingRetry) {
    
    if(!ClientConfig.chargingAt) {
      return;
    }
  
    let now = moment();
  
    if(now.hours()   != ClientConfig.chargingAtH ||
       now.minutes() != ClientConfig.chargingAtM    ) {
  
      return;
    }
  
    timedChargingRetry = 7200;  // try it 120 min

  } else {
    timedChargingRetry --;
  }


  if(activeCommands['charging'] && activeCommands['charging'].state == 'start') {
    return;
  }

  let kW = currentState.charging.status.charging.chargePower_kW;

  if(kW) {
    timedChargingRetry = 0
    return;
  }

  if(ClientConfig.chargingAt) {
    ClientConfig.chargingAt = false;
    saveClientConfig();
  }

  console.log(`Starting scheduled charging retry[secs]:${timedChargingRetry}`);

  startingTimedCharging = true;

  await doCommand({action: 'charging', state: 'start'});

  startingTimedCharging = false;
}

//-------------------------------------------------------------------------------------------
async function main() {

  try {
    console.log('loadConfig');

    loadConfig();
    loadClientConfig();
    loadData();

    console.log('VwWeConnect');

    vwConn = new api.VwWeConnect();
  
    console.log('setConfig');

    vwConn.setLogLevel("INFO"); // optional, ERROR (default), INFO, WARN or DEBUG
    vwConn.setCredentials(Config.email, Config.pwd, '');
    vwConn.setConfig("seatcupra"); // type
  
    vwConn.config.interval = 30; // min
  
    vwConn.onNewData = onNewData;
  
    console.log('getData');

    await vwConn.getData();

    setInterval(onTimer, 1000);

    retrySecs = 10;
    console.log('ready');

  } catch(e) {
    console.error('startup failed!', e);

    console.log(`retry in ${retrySecs} secs...`);
    setTimeout(main, retrySecs * 1000);

    if(retrySecs < 320)
      retrySecs *= 2;
  }

}

main();


//-------------------------------------------------------------------------------------------
/*

{
  "vin": "VSSZZZK1Z...",
  "enrollmentStatus": "completed",
  "userRole": "primary",
  "vehicleNickname": "Schneehase",
  "specifications": {
    "salesType": "K11B3C",
    "colors": {
      "exterior": "2Y",
      "interior": "UC",
      "roof": "2Y"
    },
    "wheels": {
      "rims": "C8I",
      "tires": "J50"
    },
    "steeringRight": false,
    "sunroof": false,
    "heatedSeats": true,
    "marketEntry": 2
  },
  "status": {
    "engines": {
      "primary": {
        "type": "EV",
        "fuelType": "EV",
        "range": {
          "value": 152,
          "unit": "Km"
        },
        "level": 36
      },
      "secondary": {
        "type": null,
        "fuelType": null,
        "range": null,
        "level": null
      }
    },
    "services": {
      "charging": {
        "status": "NotReadyForCharging",
        "targetPct": 80,
        "chargeMode": "manual",
        "active": false,
        "remainingTime": 0,
        "progressBarPct": 45
      },
      "climatisation": {
        "status": "Ventilation",
        "targetTemperatureKelvin": 295.15,
        "active": true,
        "remainingTime": 28,
        "progressBarPct": 0
      }
    }
  },
  "charging": {
    "status": {
      "battery": {
        "carCapturedTimestamp": "2022-08-25T10:04:44Z",
        "currentSOC_pct": 36,
        "cruisingRangeElectric_km": 152
      },
      "charging": {
        "carCapturedTimestamp": "2022-08-25T10:04:44Z",
        "chargingState": "readyForCharging",
        "chargeType": "invalid",  // "ac", "dc"
        "chargeMode": "manual",
        "chargingSettings": "default",
        "remainingChargingTimeToComplete_min": 0,
        "chargePower_kW": 0,
        "chargeRate_kmph": 0
      },
      "plug": {
        "carCapturedTimestamp": "2022-08-25T10:04:39Z",
        "plugConnectionState": "disconnected",
        "plugLockState": "unlocked",
        "externalPower": "unavailable"
      }
    }
  },
  "charging_settings": {
    "settings": {
      "maxChargeCurrentAC": "maximum",
      "carCapturedTimestamp": "2022-08-25T10:04:39Z",
      "autoUnlockPlugWhenCharged": "permanent",
      "targetSoc_pct": 80
    }
  },
  "climatisation_settings": {
    "settings": {
      "windowHeatingEnabled": true,
      "zoneFrontLeftEnabled": true,
      "zoneFrontRightEnabled": false,
      "carCapturedTimestamp": "2022-08-25T10:04:39Z",
      "targetTemperature_K": 295.15,
      "climatizationAtUnlock": true
    }
  },
  "climatisation": {
    "data": {
      "climatisationStatus": {
        "carCapturedTimestamp": "2022-08-25T10:07:44Z",
        "remainingClimatisationTime_min": 27,
        "climatisationState": "ventilation",
        "climatisationTrigger": "manual"
      },
      "windowHeatingStatus": {
        "carCapturedTimestamp": "2022-08-25T10:04:38Z",
        "windowHeatingStatus": [
          {
            "windowLocation": "front",
            "windowHeatingState": "off"
          },
          {
            "windowLocation": "rear",
            "windowHeatingState": "off"
          }
        ]
      }
    }
  }
}
*/
const fs = require('fs');
const http = require('http');
const express = require('express')
const moment = require('moment')
const axios = require('axios')

const api = require('./npm-vwconnectapi');

const app = express()

let Config;
let vwConn;
let clients = {};
let server;
let activeCommands = {}; 
let updateTimeout;
let ChargeLimit = 100;
let lastStamp, lastPollingInterval;

//-------------------------------------------------------------------------------------------
function sendCurrentData(socket, newData) {

  // check if active command timed out
  for(let key in activeCommands) {
    let command = activeCommands[key];
    let seconds = moment.utc().diff(command.stamp, 'seconds');

    if(seconds >= Config.command_timeout_secs) {
      delete activeCommands[key];
    }
  }

  vwConn.vehicles[0].activeCommands = activeCommands;
  vwConn.vehicles[0].charge_imit = ChargeLimit;
  vwConn.vehicles[0].newData = newData;
  
  socket.emit('data', vwConn.vehicles[0]);
}

//-------------------------------------------------------------------------------------------
async function sendData2abrp() {

  if(!Config['abrp_user_token'] || !Config.abrp_user_token.length) {
    return;
  }

  let data = vwConn.vehicles[0];

  let stamp = moment.utc(data.charging.status.battery.carCapturedTimestamp).unix();

  if(stamp == lastStamp) {
    return;
  }

  lastStamp = stamp;

  let doc = {
    "utc": stamp,
    "soc": data.charging.status.battery.currentSOC_pct,
    "is_charging":  data.charging.status.charging.chargePower_kW ? 1 : 0,
    "power": data.charging.status.charging.chargePower_kW,
    "car_model":"cupra:born:21:58:meb"  // https://api.iternio.com/1/tlm/get_carmodels_list?
  };

  doc = JSON.stringify(doc);
  doc = encodeURIComponent(doc);

  let url = `https://api.iternio.com/1/tlm/send?token=${Config.abrp_user_token}&api_key=${Config.abrp_api_key}&tlm=${doc}`;

  try {
    let res = await axios.get(url);
  } catch(e) {
    console.log(`Error sending 2 abrp ${e}`);
  }

}

//-------------------------------------------------------------------------------------------
async function doCommand(data) {

  console.log(`doCommand ${data.action} ${data.state}...`);

  try {
    await vwConn.setSeatCupraStatus(vwConn.vehicles[0].vin, data.action, data.state, data.body);
  } catch(e) {
    console.errro(`doCommand ${data.action} ${data.state}...${e}`);
    sendCurrentData(socket);
    return false;
  }

  activeCommands[data.action] = {
    "state": data.state,
    "stamp": moment().utc()
  };

  console.log(`doCommand ${data.action} ${data.state}...ok`);
  return true;
}

//-------------------------------------------------------------------------------------------
function requestUpdate() {

  if(updateTimeout) {
    clearTimeout(updateTimeout);
    updateTimeout = null;
  }

  vwConn.update();
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
      action: req.query.action,
      state: req.query.state
    }

    if(await doCommand(data)) {
      res.send('+OK');
    } else {
      res.send('-ERROR');
    }
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
    });

    //-------------------------------------------------------------------------------------------
    socket.on('update', async function() {
      requestUpdate();
    });

    //-------------------------------------------------------------------------------------------
    socket.on('set_charge_limit', async function(charge_limit) {
      ChargeLimit = charge_limit;
      onNewData();
    });
    

    //-------------------------------------------------------------------------------------------
    sendCurrentData(socket);
    requestUpdate();
  });

}

//-------------------------------------------------------------------------------------------
async function onNewData() {

  if(!server) {
    startServer();
  }

  let cnt = 0;

  for(let key in clients) {
    let socket = clients[key];
    sendCurrentData(socket, true);
    cnt++;
  }

  // check charge limit
  if(ChargeLimit < 100 && 
     vwConn.vehicles[0].charging.status.battery.currentSOC_pct >= ChargeLimit && 
     vwConn.vehicles[0].charging.status.charging.chargePower_kW > 0) {

    if(!activeCommands['charging'] || activeCommands['charging'].state != 'stop') {
      console.log('charging limit reached, stopping charging ' + vwConn.vehicles[0].charging.status.battery.currentSOC_pct + '>=' + ChargeLimit);
      await doCommand({action: 'charging', state: 'stop'});
      requestUpdate();
    }

    ChargeLimit = 100;
    onNewData();
  }

  sendData2abrp();

  if(updateTimeout) {
    return;
  }

  let secs = Config.refresh_secs;

  // slow polling when not needed
  if(!cnt && (ChargeLimit == 100 || vwConn.vehicles[0].charging.status.charging.chargePower_kW == 0) ) {

    let data = vwConn.vehicles[0];
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
    lastPollingInterval = secs;
    console.log(`now polling in ${secs} secs`);
  }

  // start next polling
  updateTimeout = setTimeout(function() {
    vwConn.update();
    updateTimeout = null;
  }, secs * 1000);
}

//-------------------------------------------------------------------------------------------
function loadConfig() {
  const data = fs.readFileSync('./config.json', 'utf8');
  Config = JSON.parse(data);  
}

//-------------------------------------------------------------------------------------------
async function main() {

  try {
    console.log('loadConfig');

    loadConfig();

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

    console.log('ready');

  } catch(e) {
    console.error('ERROR ' + e);
    process.exit(1);
  }

}

main();


//-------------------------------------------------------------------------------------------
/*

{
 "vin": "VSSZZZK1ZNP003241",
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
 "charging": {
  "status": {
   "battery": {
    "carCapturedTimestamp": "2022-03-25T11:47:22Z",
    "currentSOC_pct": 67,
    "cruisingRangeElectric_km": 243
   },
   "charging": {
    "carCapturedTimestamp": "2022-03-25T11:47:22Z",
    "chargingState": "readyForCharging",
    "chargeType": "invalid",
    "chargeMode": "manual",
    "chargingSettings": "default",
    "remainingChargingTimeToComplete_min": 0,
    "chargePower_kW": 0,
    "chargeRate_kmph": 0
   },
   "plug": {
    "carCapturedTimestamp": "2022-03-25T11:47:41Z",
    "plugConnectionState": "disconnected",
    "plugLockState": "unlocked",
    "externalPower": "unavailable"
   }
  }
 },
 "climatisation": {
  "data": {
   "climatisationStatus": {
    "carCapturedTimestamp": "2022-03-25T11:47:45Z",
    "remainingClimatisationTime_min": 0,
    "climatisationState": "off",
    "climatisationTrigger": "off"
   },
   "windowHeatingStatus": {
    "carCapturedTimestamp": "2022-03-25T11:47:25Z",
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
 },
 "status": {
  "engines": {
   "primary": {
    "type": "EV",
    "fuelType": "EV",
    "range": {
     "value": 243,
     "unit": "Km"
    },
    "level": 67
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
    "progressBarPct": 84
   },
   "climatisation": {
    "status": "Off",
    "active": false,
    "remainingTime": 0,
    "progressBarPct": 0
   }
  }
 }
}

*/

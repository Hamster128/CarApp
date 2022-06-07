# CarApp
Node.js express application which delivers a car control web app<br/>
Currentlly only working with Cupra Born
Can also send live data to abrp (a better route planner)

## Setup
edit config.json<br/>
start:

    node index.js

## Open
direct your browser to http://locahost:8080/index.html

## Widget for your phone
http://locahost:8080/widget.html

## Send direct commands
http://locahost:8080/execute.cmd?action=climatisation&state=start&key=0996dfbj3hvj4v<br/>
http://locahost:8080/execute.cmd?action=climatisation&state=stop&key=0996dfbj3hvj4v<br/>
http://locahost:8080/execute.cmd?action=charging&state=start&key=0996dfbj3hvj4v<br/>
http://locahost:8080/execute.cmd?action=charging&state=stop&key=0996dfbj3hvj4v<br/>

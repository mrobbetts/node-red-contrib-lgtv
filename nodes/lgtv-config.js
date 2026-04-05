module.exports = function (RED) {
    let status;
    let token;
    let lgtv;

    function LgtvConfigNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.host = config.host;
        node.secure = config.secure !== false && config.secure !== 'false';
        node.users = {};
        const subscriptions = {};

        const tvUrl = (node.secure ? 'wss://' : 'ws://') + node.host + (node.secure ? ':3001' : ':3000');
        let connectingTimer = null;

        const lgtvOpts = {
            url: tvUrl,
            clientKey: node.credentials.token,
            saveKey(key, cb) {
                token = key;
                RED.nodes.addCredentials(node.id, {
                    token: key
                });
                if (typeof cb === 'function') {
                    cb();
                }
            }
        };

        if (node.secure) {
            lgtvOpts.wsconfig = {
                keepalive: true,
                keepaliveInterval: 10000,
                dropConnectionOnKeepaliveTimeout: true,
                keepaliveGracePeriod: 5000,
                tlsOptions: {rejectUnauthorized: config.verifycert === true}
            };
        }

        const lgtv = require('lgtv2')(lgtvOpts);

        lgtv.on('connecting', () => {
            node.setStatus('connecting');
            clearTimeout(connectingTimer);
            connectingTimer = setTimeout(() => {
                node.warn('Connection stuck, forcing retry');
                lgtv.disconnect();
            }, 30000);
        });

        lgtv.on('connect', () => {
            clearTimeout(connectingTimer);
            node.setStatus('connect');
            node.connected = true;
            node.emit('tvconnect');

            Object.keys(subscriptions).forEach(url => {
                const payload = subscriptions[url]._payload;
                if (payload) {
                    lgtv.subscribe(url, payload, (err, res) => {
                        node.subscriptionHandler(url, err, res);
                    });
                } else {
                    lgtv.subscribe(url, (err, res) => {
                        node.subscriptionHandler(url, err, res);
                    });
                }
            });

            lgtv.getSocket('ssap://com.webos.service.networkinput/getPointerInputSocket',
                (err, sock) => {
                    if (!err) {
                        node.buttonSocket = sock;
                    }
                }
            );
        });

        lgtv.on('error', e => {
            clearTimeout(connectingTimer);
            node.connected = false;
            node.setStatus(e.code);
            node.emit('tvclose');
            setTimeout(() => {
                lgtv.connect(tvUrl);
            }, 5000);
        });

        lgtv.on('close', () => {
            clearTimeout(connectingTimer);
            node.emit('tvclose');
            node.connected = false;
            node.buttonSocket = null;
            node.setStatus('close');
            setTimeout(() => {
                lgtv.connect(tvUrl);
            }, 5000);
        });

        lgtv.on('prompt', () => {
            node.setStatus('prompt');
        });

        this.subscriptionHandler = function (url, err, res) {
            if (subscriptions[url]) {
                Object.keys(subscriptions[url]).forEach(id => {
                    if (id !== '_payload') {
                        subscriptions[url][id](err, res);
                    }
                });
            }
        };

        this.subscribe = function (id, url, payload, callback) {
            if (typeof payload === 'function') {
                callback = payload;
                payload = undefined;
            }

            if (!subscriptions[url]) {
                subscriptions[url] = {_payload: payload};
                if (node.connected) {
                    if (payload) {
                        lgtv.subscribe(url, payload, (err, res) => {
                            node.subscriptionHandler(url, err, res);
                        });
                    } else {
                        lgtv.subscribe(url, (err, res) => {
                            node.subscriptionHandler(url, err, res);
                        });
                    }
                }
            }

            subscriptions[url][id] = callback;
        };

        this.request = function (url, payload, callback) {
            if (node.connected) {
                lgtv.request(url, payload, callback);
            }
        };

        this.reconnect = function () {
            if (!node.connected) {
                lgtv.disconnect();
                setTimeout(() => {
                    lgtv.connect(tvUrl);
                }, 1000);
            }
        };

        this.register = function (lgtvNode) {
            node.users[lgtvNode.id] = lgtvNode;
        };

        this.deregister = function (lgtvNode, done) {
            delete node.users[lgtvNode.id];
            Object.keys(subscriptions).forEach(url => {
                delete subscriptions[url][lgtvNode.id];
            });
            return done();
        };

        this.setStatus = function (c) {
            status = c;
            let s;
            switch (c) {
                case 'connecting':
                    s = {
                        fill: 'yellow',
                        shape: 'ring',
                        text: 'node-red:common.status.connecting'
                    };
                    break;
                case 'prompt':
                    s = {
                        fill: 'yellow',
                        shape: 'ring',
                        text: c
                    };
                    break;
                case 'connect':
                    s = {
                        fill: 'green',
                        shape: 'dot',
                        text: 'node-red:common.status.connected'
                    };
                    break;
                case 'disconnected':
                    s = {
                        fill: 'red',
                        shape: 'ring',
                        text: 'node-red:common.status.disconnected'
                    };
                    break;
                default:
                    s = {
                        fill: 'red',
                        shape: 'ring',
                        text: c
                    };
            }

            Object.keys(node.users).forEach(id => {
                node.users[id].status(s);
            });
        };
    }

    RED.httpAdmin.get('/lgtv-connect', (req, res) => {
        if (!status || status === 'Close') {
            const secure = req.query.secure !== 'false';
            const pairUrl = (secure ? 'wss://' : 'ws://') + req.query.host + (secure ? ':3001' : ':3000');
            lgtv = require('lgtv2')({
                url: pairUrl,
                saveKey(key, cb) {
                    token = key;
                    RED.nodes.addCredentials(req.query.id, {
                        token: key
                    });
                    if (typeof cb === 'function') {
                        cb();
                    }
                }
            });

            status = 'Connecting';

            setTimeout(() => {
                lgtv.disconnect();
                status = '';
            }, 31000);

            lgtv.on('connecting', () => {
                status = 'Connecting';
            });

            lgtv.on('connect', () => {
                lgtv.disconnect();
                status = 'Connected';
            });

            lgtv.on('error', e => {
                status = 'Error: ' + e.code.toLowerCase();
            });

            lgtv.on('prompt', () => {
                status = 'Please answer the prompt on your TV';
            });
        }

        res.status(200).send(JSON.stringify({
            state: status,
            token
        }));
    });

    RED.nodes.registerType('lgtv-config', LgtvConfigNode, {
        credentials: {
            token: {type: 'text'}
        }
    });
};

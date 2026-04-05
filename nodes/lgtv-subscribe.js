module.exports = function (RED) {
    function LgtvSubscribeNode(n) {
        RED.nodes.createNode(this, n);
        const node = this;
        this.tv = n.tv;
        this.url = n.url;

        let configPayload;
        try {
            configPayload = n.payload ? JSON.parse(n.payload) : undefined;
        } catch (e) {
            configPayload = undefined;
        }

        this.tvConn = RED.nodes.getNode(this.tv);

        if (this.tvConn) {
            this.tvConn.register(node);

            this.on('close', done => {
                node.tvConn.deregister(node, done);
            });

            if (node.url) {
                node.tvConn.subscribe(node.id, node.url, configPayload, (err, res) => {
                    if (err) {
                        node.warn('Subscribe error: ' + JSON.stringify(err));
                    } else {
                        node.send({topic: node.url, payload: res});
                    }
                });
            }

            node.on('input', msg => {
                const url = msg.topic || node.url;
                const payload = msg.payload || configPayload;
                if (url) {
                    node.tvConn.subscribe(node.id, url, payload, (err, res) => {
                        if (err) {
                            node.warn('Subscribe error: ' + JSON.stringify(err));
                        } else {
                            node.send({topic: url, payload: res});
                        }
                    });
                }
            });
        } else {
            this.error('No TV Configuration');
        }
    }

    RED.nodes.registerType('lgtv-subscribe', LgtvSubscribeNode);
};

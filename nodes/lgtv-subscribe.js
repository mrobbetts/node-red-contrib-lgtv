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

            const doSubscribe = function (url, payload) {
                node.tvConn.subscribe(node.id, url, payload, (err, res) => {
                    if (err) {
                        node.warn('Subscribe error: ' + JSON.stringify(err));
                    } else {
                        node.send({topic: url, payload: res});
                    }
                });
            };

            if (node.url) {
                doSubscribe(node.url, configPayload);
            }

            node.on('input', msg => {
                const url = msg.topic || node.url;
                if (!url) {
                    return;
                }

                // Only use msg.payload if msg.topic was provided
                // (meaning the user intentionally sent subscription params).
                // Otherwise fall back to the configured payload.
                const payload = msg.topic ? msg.payload : configPayload;
                doSubscribe(url, payload);
            });
        } else {
            this.error('No TV Configuration');
        }
    }

    RED.nodes.registerType('lgtv-subscribe', LgtvSubscribeNode);
};

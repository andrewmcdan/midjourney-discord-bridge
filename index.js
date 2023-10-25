const axios = require("axios");
const Discordie = require("discordie");
const {distance} = require("fastest-levenshtein");

class MidjourneyDiscordBridge {
    constructor(discord_token, guild_id, channel_id, timeout = 10) {
        /**
         * @param {string} discord_token - Your discord token that has access to Midjourney bot
         * @param {int} guild_id - The guild ID that the bot is in
         * @param {int} channel_id - The channel ID that the bot is in
         */

        this.MIDJOURNEY_BOT_ID = "936929561302675456";
        this.MIDJOURNEY_BOT_CHANNEL = channel_id;
        this.GUILD_ID = guild_id;
        this.discord_token = discord_token;
        this.client = new Discordie();
        const Events = Discordie.Events;
        this.queue = [];
        this.session_id = "55c4bd6c10df4a06c8c9109f96dbddd3";
        this.loggerCB = null;
        this.disconnectResolver = null;
        this.lastPayload = null;
        this.loggedIn = false;
        this.loginResolver = null;
        this.loginPromise = new Promise((resolve) => {
            this.loginResolver = resolve;
        });
        this.timeout = timeout;

        this.client.Dispatcher.on("MESSAGE_CREATE", (e) => {
            const content = e.message.content;
            const channel = e.message.channel;
            if (content === "ping") channel.sendMessage("pong");
            if (content === "do") doCommand(e);
            if (content === "undo") undoCommand(e);
            this._newDiscordMsg(e, false);
        });

        this.client.Dispatcher.on("MESSAGE_UPDATE", (e) => this._newDiscordMsg(e, true));

        this.client.Dispatcher.on(Events.GATEWAY_READY, e => {
            //this.logger("\nConnected to the Discord as: " + this.client.User.username);
            this.loggedIn = true;
            this.loginResolver(); // Call the stored resolve function
        });

        this.client.Dispatcher.on(Events.DISCONNECTED, e => {
            //this.logger('Disconnected from Discord. Reconnecting...');
            this.client.connect({ token: this.discord_token });
        });

        this.client.connect({ token: this.discord_token });

        this.client.Dispatcher.on(Events.GATEWAY_DISCONNECT, (e) => {
            if (this.disconnectResolver != null) this.disconnectResolver();
        });
    }

    _getProgress(str) {
        const regex = /\((\d+)%\)/;
        const match = str.match(regex);
        if (match) {
            return match[1];
        } else {
            return 100;
        }
    }

    _findItem(prompt) {
        // console.log("Finding prompt:", prompt);
        for (let i = 0; i < this.queue.length; i++) {
            // we have to make sure that there aren't any double spaces in either string because apparently 
            // either Discord or Midjourney is removing them and screwing things up
            let str1 = this.queue[i].prompt;
            let str2 = prompt;
            str1 = str1.replace("  ", " ");
            str2 = str2.replace("  ", " ");
            let dist = distance(str2, str1);
            // fuzzy string matching, basically 1% of the prompt is allowed to be different, just in case MJ or Discord messes with the prompt.
            if(dist <= (prompt.length - this.queue[i].prompt.length + (prompt.length * 0.01))) return i;
        }
        return null;
    }


    async _newDiscordMsg(e, update) {
        /**
         * Handle a new message from Discord.
         */

        if (e == null) return;
        if (e.socket == null) return;
        this.session_id = e.socket.sessionId;
        if (e.message == null) return;
        if (e.message.content == null) return;
        if (e.message.attachments == null) return;
        if (e.message.author == null) return;
        // Not a DM and not from the bot itself
        if (e.message.author.id != this.MIDJOURNEY_BOT_ID) return;
        if (e.data != null) {
            if (e.data.interaction != null) {
                if (e.data.interaction.name == "info") {
                    let obj = this.queue[0];
                    if (obj == null) return;
                    if (obj.prompt != "info") return;
                    obj.resolve(e.data);
                    this.queue.pop(0);
                    return;
                }
            }
        }

        let img = e.message.attachments[0];
        // this.logger(JSON.stringify(e,null,2));
        if (img === undefined) {
            if (
                (e.message.content.includes("Bad response") ||
                    e.message.content.includes("Internal Error") ||
                    e.message.content.includes("There was an error processing your request.") ||
                    e.message.content.includes("Invlid Form Body")
                ) && this.lastPayload != null) {
                // check to see if this is a bad response to a payload we sent
                if (this._findItem(e.message.content) != null) {
                    // wait for a bit then resend the payload
                    for (let i = 0; i < 3; i++) await this.waitTwoOrThreeSeconds();
                    this.sendPaylod(this.lastPayload);
                }
            }
            return;
        }

        const regexString = "([A-Za-z0-9]+(-[A-Za-z0-9]+)+)";
        const regex = new RegExp(regexString);
        const matches = regex.exec(img.url);
        let uuid = "";
        img.uuid = {};
        img.uuid.flag = 0;
        if (matches[0] == "ephemeral-attachments") {
            uuid = img.url.substring(img.url.indexOf(".png?") - 36, img.url.indexOf(".png?"));
            img.uuid.flag = 64;
        } else {
            uuid = matches[0];
        }

        img.uuid.value = uuid
        img.id = e.message.id;
        img.prompt = e.message.content.substring(2, e.message.content.lastIndexOf("** "));

        // let prompt_msg = e.message.content.substring(2); // Remove first two characters **
        //console.log("prompt_msg:", img.prompt);
        let index = this._findItem(e.message.content);
        if (index == null) {
            return;
        }


        let item = this.queue[index];
        if (update) {
            if (item.cb !== null) {
                let progress = this._getProgress(e.message.content);
                item.cb(img.url, progress);
            }
            return;
        } else {
            // Image generation finished!
            clearTimeout(item.timeout);
            item.resolve(img);
            this.queue.pop(index);
        }
    }

    _waitForDiscordMsg(obj) {
        this.logger("Waiting for Discord message...");
        return new Promise((resolve) => {
            obj.resolve = resolve;
            obj.timeout = setTimeout(() => {
                this.logger("Timeout waiting for Discord message (10 minutes)");
                obj.resolve(null);
            }, 1000 * 60 * this.timeout); // 10 minutes timeout by default
        });
    }

    _waitForDiscordDisconnectg() {
        if (!this.client.connected) {
            return;
        }
        return new Promise((resolve) => {
            this.logger("Waiting for Discord disconnect");
            this.disconnectResolver = resolve;
        });
    }

    async waitTwoOrThreeSeconds() {
        // waits like 2, 3 -ish seconds to try and avoid automation detection
        await new Promise(resolve => setTimeout(resolve, 1000 * (Math.floor(Math.random() * 5) + 2)));
    };

    buildPayload(type, custom_id, obj) {
        const payload = {
            type: type,
            guild_id: this.GUILD_ID,
            channel_id: this.MIDJOURNEY_BOT_CHANNEL,
            message_flags: obj.uuid.flag,
            message_id: obj.id,
            application_id: "936929561302675456",
            session_id: this.session_id,
            data: {
                component_type: 2,
                custom_id: custom_id,
            }
        };
        return payload;
    }

    async cancelJob() {
        if (this.currentJobObj == null) {
            return;
        }
        if (!this.loggedIn) {
            await this.loginPromise;
        }
        this.logger("Cancelling job for image:", this.currentJobObj.uuid.value);
        const payload = this.buildPayload(3, "MJ::CancelJob::ByJobid::" + this.currentJobObj.uuid.value, this.currentJobObj);
        this.sendPaylod(payload);
        return;
    }

    async variation(obj, selectedImage, prompt, callback = null) {
        // console.log("variation called\n", {obj}, {selectedImage}, {prompt})
        this.currentJobObj = obj;
        if (!this.loggedIn) {
            await this.loginPromise;
        }
        this.logger("Waiting for a bit then calling variation...");
        await this.waitTwoOrThreeSeconds();
        this.logger("Variation image:", obj.uuid.value);
        const payload = this.buildPayload(3, "MJ::JOB::variation::" + selectedImage + "::" + obj.uuid.value, obj);
        this.sendPaylod(payload);
        let obj1 = { prompt: prompt, cb: callback };
        this.queue.push(obj1);
        let ret = await this._waitForDiscordMsg(obj1);
        if (ret == null) {
            return null;
        }
        ret.prompt = prompt;
        return ret;
    }

    async zoomOut(obj, prompt, callback = null) {
        this.currentJobObj = obj;
        if (!this.loggedIn) {
            await this.loginPromise;
        }
        this.logger("Waiting for a bit then calling zoom out...");
        await this.waitTwoOrThreeSeconds();
        this.logger("Zoom out image:", obj.uuid.value);
        const payload = this.buildPayload(3, "MJ::Outpaint::50::1::" + obj.uuid.value + "::SOLO", obj);
        this.sendPaylod(payload);
        let obj1 = { prompt: prompt, cb: callback };
        this.queue.push(obj1);
        let ret = await this._waitForDiscordMsg(obj1);
        if (ret == null) {
            return null;
        }
        ret.prompt = prompt;
        return ret;
    }

    async rerollImage(obj, prompt, callback = null) {
        this.currentJobObj = obj;
        if (!this.loggedIn) {
            await this.loginPromise;
        }
        this.logger("Waiting for a bit then calling reroll...");
        await this.waitTwoOrThreeSeconds();
        this.logger("Reroll image:", obj.uuid.value);
        const payload = this.buildPayload(3, "MJ::JOB::reroll::0::" + obj.uuid.value + "::SOLO", obj);
        this.sendPaylod(payload);
        let obj1 = { prompt: prompt, cb: callback };
        this.queue.push(obj1);
        let ret = await this._waitForDiscordMsg(obj1);
        if (ret == null) {
            return null;
        }
        ret.prompt = prompt;
        return ret;
    }

    async upscaleImage(obj, imageNum, prompt, callback = null) {
        this.currentJobObj = obj;
        this.logger("Waiting for a bit then calling for upscaled image...");
        await this.waitTwoOrThreeSeconds();
        if (!this.loggedIn) {
            await this.loginPromise;
        }
        this.logger("Upscaling image #" + imageNum + " from ", obj.uuid.value);
        const payload = this.buildPayload(3, "MJ::JOB::upsample::" + imageNum + "::" + obj.uuid.value, obj);
        this.sendPaylod(payload);
        let obj1 = { prompt: prompt, cb: callback };
        this.queue.push(obj1);
        let ret = await this._waitForDiscordMsg(obj1);
        if (ret == null) {
            return null;
        }
        ret.prompt = prompt;
        return ret;
    }

    async getInfo() {
        if (!this.loggedIn) {
            await this.loginPromise;
        }
        const payload = {
            type: 2,
            application_id: "936929561302675456",
            guild_id: this.GUILD_ID,
            channel_id: this.MIDJOURNEY_BOT_CHANNEL,
            session_id: this.session_id,
            data: {
                version: "1118961510123847776",
                id: "972289487818334209",
                name: "info",
                type: 1,
                options: [],
                application_command: {
                    id: "972289487818334209",
                    application_id: "936929561302675456",
                    version: "1118961510123847776",
                    default_member_permissions: null,
                    type: 1,
                    nsfw: false,
                    name: "info",
                    description: "View information about your profile.",
                    dm_permission: true,
                    contexts: [
                        0,
                        1,
                        2
                    ],
                    integration_types: [
                        0
                    ]
                },
                attachments: []
            }
        };

        this.sendPaylod(payload);
        let obj1 = { prompt: "info", cb: null };
        this.queue.push(obj1);
        return await this._waitForDiscordMsg(obj1);
    }

    async sendPaylod(payload) {
        if (!this.loggedIn) {
            await this.loginPromise;
        }

        this.lastPayload = payload;

        const headers = {
            authorization: this.discord_token,
        };

        try {
            const response = await axios.post(
                "https://discord.com/api/v9/interactions",
                payload,
                { headers }
            );
            this.logger(response.data);
        } catch (error) {
            if (error.response) {
                // The request was made, and the server responded with a status code that falls out of the range of 2xx
                console.error(
                    "Error response:",
                    error.response.status,
                    error.response.data
                );
            } else if (error.request) {
                // The request was made, but no response was received
                console.error("No response received:", error.request);
            } else {
                // Something happened in setting up the request that triggered an Error
                console.error("Error during request setup:", error.message);
            }
        }
    }

    async generateImage(prompt, callback = null) {
        /**
         * Generate image from the prompt.
         * @param {string} prompt - What image you'd like to see
         * @param {function} callback - Optional callback function to call when image is ready
         * @returns {string} - The image URL
         */
        if (!this.loggedIn) {
            await this.loginPromise;
        }

        const payload = {
            type: 2,
            application_id: "936929561302675456",
            guild_id: this.GUILD_ID,
            channel_id: this.MIDJOURNEY_BOT_CHANNEL,
            session_id: this.session_id,
            data: {
                version: "1118961510123847772",
                id: "938956540159881230",
                name: "imagine",
                type: 1,
                options: [
                    {
                        type: 3,
                        name: "prompt",
                        value: prompt
                    }
                ],
                application_command: {
                    id: "938956540159881230",
                    application_id: "936929561302675456",
                    version: "1118961510123847772",
                    default_member_permissions: null,
                    type: 1,
                    nsfw: true,
                    name: "imagine",
                    description: "Create images with Midjourney",
                    dm_permission: true,
                    contexts: [
                        0,
                        1,
                        2
                    ],
                    integration_types: [
                        0
                    ],
                    options: [
                        {
                            type: 3,
                            name: "prompt",
                            description: "The prompt to imagine",
                            required: true
                        }
                    ]
                },
                attachments: []
            }
        };

        this.sendPaylod(payload);

        let obj1 = { prompt: prompt, cb: callback };
        this.queue.push(obj1);
        let ret = await this._waitForDiscordMsg(obj1);
        if (ret == null) {
            return null;
        }
        ret.prompt = prompt;
        return ret;
    }

    async close() {
        this.client.disconnect();
        return await this._waitForDiscordDisconnectg();
    }

    logger(msg) {
        if (this.loggerCB == null) {
            console.log("MJ-Discord Bridge Logger:", { msg });
        } else {
            this.loggerCB(msg);
        }

    }

    registerLoggerCB(cb) {
        this.loggerCB = cb;
    }
}

module.exports = {
    MidjourneyDiscordBridge,
};
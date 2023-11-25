import { EventEmitter } from 'events';
import AWS from 'aws-sdk';
import axios from 'axios';

function parseNoisyJSON(noisyString) {
    let parsedObjects = [];
    let bracketCount = 0;
    let jsonString = '';
    let insideString = false;
    let lastClosingIndex = 0;

    for (let i = 0; i < noisyString.length; i++) {
        const char = noisyString[i];
        const prevChar = i > 0 ? noisyString[i - 1] : '';
        const prevPrevChar = i > 1 ? noisyString[i - 2] : '';
        const prevCharNotEscape = prevChar !== '\\' || (prevChar === prevPrevChar);

        if (char === '"' && prevCharNotEscape) {
            insideString = !insideString;
        }
        if (!insideString && char === '{') {
            bracketCount += 1;
        }
        if (bracketCount > 0) {
            jsonString += char;
        }
        if (!insideString && char === '}') {
            bracketCount -= 1;
        }

        if (jsonString.length > 0 && bracketCount === 0 && !insideString) {
            try {
                parsedObjects.push(JSON.parse(jsonString));
                lastClosingIndex = i;
            } catch (e) {
                // The string was not a valid JSON object, so we ignore it
            }
            jsonString = '';
        }
    }
    return {
        jsons: parsedObjects,
        residue: noisyString.slice(lastClosingIndex + 1),
    };
}

class MessageQueue {

    constructor(put) {
        this.queue = [];
        this.idle = true;
        this.put = put;
    }

    enqueue(item) {
        this.queue.push(item);
        if (this.idle) {
            this.process();
        }
    }

    async process() {
        this.idle = false;
        while (this.queue.length > 0) {
            const payload = this.queue.shift();
            await this.put(payload);
        }
        this.idle = true;
    }
}

export const handler = async (event) => {

    const { AWS_REGION } = process.env;
    const apiId = event.requestContext.apiId;
    const stage = event.requestContext.stage;
    const connectionId = event.requestContext.connectionId;
    const callbackUrlForAWS = `https://${apiId}.execute-api.${AWS_REGION}.amazonaws.com/${stage}`;
    
    const apigwManagementApi = new AWS.ApiGatewayManagementApi({
        apiVersion: '2018-11-29',
        endpoint: callbackUrlForAWS
    });

    try {
        const eventEmitter = new EventEmitter();

        const {
            urlType,
            apiKey,
            baseURL,
            model,
            requestId,
            messages,
            temperature,
            top_p,
        } = JSON.parse(event.body);

        const requestConfig = urlType === 'openai' ?
        {
            method: 'post',
            responseType: 'stream',
            url: `${baseURL}/v1/chat/completions`,
            headers: { Authorization: `Bearer ${apiKey}` },
            data: {
                model,
                messages,
                top_p,
                temperature,
                max_tokens: 800,
                stream: true,
            },
        }
            :
        {
            method: 'post',
            responseType: 'stream',
            url: baseURL,
            headers: { 'API-Key': apiKey },
            data: {
                messages,
                top_p,
                temperature,
                max_tokens: 800,
                stream: true,
            },
        };

        const processQueue = new MessageQueue(async (data) => {
            await apigwManagementApi.postToConnection({
                ConnectionId: connectionId,
                Data: JSON.stringify({
                    ...data,
                    requestId,
                }),
            }).promise();
    
            if (data.finish_reason === 'stop') {
                eventEmitter.emit('stop');
            }
        });

        const response = await axios(requestConfig);
    
        let lastChunkTime = new Date().getTime();
        let checkTimeout = setInterval(async () => {
            if (new Date().getTime() - lastChunkTime > 9000) {
                clearInterval(checkTimeout);
                await apigwManagementApi.postToConnection({
                    ConnectionId: connectionId,
                    Data: JSON.stringify({
                        finish_reason: 'timeout',
                        requestId,
                    }),
                }).promise();
                eventEmitter.emit('stop');
            }
        }, 900);
    
        let residue = '';
        response.data.on('data', (chunk) => {
            lastChunkTime = new Date().getTime();
            const result = parseNoisyJSON(residue + chunk.toString());
            residue = result.residue;
            for (const { choices } of result.jsons) {
                if (choices && choices.length) {
                    processQueue.enqueue(choices[0]);
                    if (choices[0].finish_reason === 'stop' || choices[0].finish_details) {
                        clearInterval(checkTimeout);
                    }
                }
            }
        });
    
        return new Promise(resolve => {
            eventEmitter.on('stop', () => resolve({ statusCode: 200 }));
        });

    } catch (error) {
        console.log(error);
        const { requestId } = JSON.parse(event.body);
        await apigwManagementApi.postToConnection({
            ConnectionId: connectionId,
            Data: JSON.stringify({
                finish_reason: 'error',
                requestId,
            }),
        }).promise();

        return { statusCode: 200 };
    }
}

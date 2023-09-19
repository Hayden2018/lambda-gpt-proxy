import AWS from 'aws-sdk';
import OpenAI from 'openai';
import { EventEmitter } from 'events';
const { Configuration, OpenAIApi } = OpenAI;

function parseNoisyJSON(noisyString) {
    let parsedObjects = [];
    let bracketCount = 0;
    let jsonString = '';
    let insideString = false;

    for (let i = 0; i < noisyString.length; i++) {
        let char = noisyString[i];
        let prevChar = i > 0 ? noisyString[i - 1] : null;

        if (char === '"' && prevChar !== '\\') {
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
            } catch (e) {
                // The string was not a valid JSON object, so we ignore it
            }
            jsonString = '';
        }
    }
    return parsedObjects;
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
            apiKey,
            baseURL,
            model,
            requestId,
            messages,
            temperature,
            top_p,
        } = JSON.parse(event.body);
    
        const configuration = new Configuration({ apiKey, basePath: `${baseURL}/v1/` });
        const openai = new OpenAIApi(configuration);
    
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
    
        const completion = await openai.createChatCompletion({
            model,
            messages,
            temperature,
            top_p,
            stream: true,
        }, { responseType: 'stream' });
    
        const stream = completion.data;
    
        let lastChunkTime = new Date().getTime();
        let timeoutChecker = setInterval(async () => {
            if (new Date().getTime() - lastChunkTime > 8000) {
                clearInterval(timeoutChecker);
                await apigwManagementApi.postToConnection({
                    ConnectionId: connectionId,
                    Data: JSON.stringify({
                        finish_reason: 'error',
                        delta: { },
                        requestId,
                    }),
                }).promise();
                eventEmitter.emit('stop');
            }
        }, 1000);
    
        stream.on('data', async (chunk) => {
            lastChunkTime = new Date().getTime();
            const jsonChunks = parseNoisyJSON(chunk.toString());
            for (const data of jsonChunks) {
                if (data.choices && data.choices.length) {
                    processQueue.enqueue(data.choices[0]);
                    if (data.choices[0].finish_reason === 'stop') clearInterval(timeoutChecker);
                }
            }
        });
    
        return new Promise(resolve => {
            eventEmitter.on('stop', () => resolve({ statusCode: 200 }));
        });

    } catch (error) {
        await apigwManagementApi.postToConnection({
            ConnectionId: connectionId,
            Data: JSON.stringify({
                finish_reason: 'error',
                delta: { },
                requestId,
            }),
        }).promise();

        return { statusCode: 200 };
    }
}

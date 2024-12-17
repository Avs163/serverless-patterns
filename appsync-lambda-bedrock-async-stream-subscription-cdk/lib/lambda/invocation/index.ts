import { BedrockRuntimeClient, InvokeModelWithResponseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { GraphQLClient } from 'graphql-request';
import { v4 as uuidv4 } from 'uuid';

interface AppSyncEvent {
  arguments: {
    input: string;
  };
}

export const handler = async (event: AppSyncEvent, context: any) => {
  console.log('Step 2: Lambda received event:', JSON.stringify(event, null, 2));

  // Prevent Lambda from terminating early
  context.callbackWaitsForEmptyEventLoop = false;

  const bedrockClient = new BedrockRuntimeClient();
  const graphQLClient = new GraphQLClient(process.env.APPSYNC_ENDPOINT!, {
    headers: {
      'x-api-key': process.env.APPSYNC_API_KEY!
    },
  });

  try {
    const input = event.arguments.input;
    if (!input) {
      throw new Error('Input is required');
    }

    // Generate a unique conversationId
    const conversationId = uuidv4();
    console.log('Generated conversationId:', conversationId);

    // Start processing Bedrock stream in the background
    processBedrockStream(bedrockClient, graphQLClient, input, conversationId);

    // Return immediate response to AppSync mutation caller
    return {
      conversationId,
      status: "PROCESSING"
    };

  } catch (error) {
    console.error('Lambda execution error:', error);
    if (error instanceof Error) {
      return {
        conversationId: 'error',
        status: error.message
      };
    }
    return {
      conversationId: 'error',
      status: 'Unknown error occurred'
    };
  }
};

// Function to handle Bedrock streaming in the background
async function processBedrockStream(
  bedrockClient: BedrockRuntimeClient,
  graphQLClient: GraphQLClient,
  input: string,
  conversationId: string
) {
  try {
    const params = {
      modelId: "anthropic.claude-v2",
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 4096,
        messages: [{
          role: "user",
          content: input
        }]
      })
    };

    console.log('Invoking Bedrock with params:', JSON.stringify(params, null, 2));
    const command = new InvokeModelWithResponseStreamCommand(params);
    const stream = await bedrockClient.send(command);

    if (stream.body) {
      let accumulatedText = '';

      for await (const chunk of stream.body) {
        if (chunk.chunk?.bytes) {
          const parsed = JSON.parse(
            Buffer.from(chunk.chunk.bytes).toString("utf-8")
          );
          console.log('Received chunk from Bedrock:', parsed);

          if (parsed.delta?.text) {
            accumulatedText += parsed.delta.text;

            // Send chunk update via AppSync mutation
            const mutation = `
              mutation SendChunk($conversationId: ID!, $chunk: String!) {
                sendChunk(conversationId: $conversationId, chunk: $chunk) {
                  conversationId
                  chunk
                }
              }
            `;

            try {
              await graphQLClient.request(mutation, {
                conversationId,
                chunk: parsed.delta.text
              });
              console.log('Chunk sent to subscription:', parsed.delta.text);
            } catch (error) {
              console.error('Error sending chunk to subscription:', error);
            }
          }
        }
      }

      console.log('Completed streaming. Total accumulated text:', accumulatedText);
    }
  } catch (error) {
    console.error('Error during Bedrock streaming:', error);
  }
}

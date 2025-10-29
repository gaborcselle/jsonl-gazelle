# AGENTS.md - AI Agent Integration Guide

This document explains how AI agents can interact with, extend, and integrate with the JSONL Gazelle VS Code extension.

## Overview

JSONL Gazelle is a VS Code extension that provides a powerful interface for viewing, editing, and analyzing JSONL (JSON Lines) files. It features table views, AI integration, search capabilities, and export functionality. This guide outlines how AI agents can leverage and extend these capabilities.

## Core Architecture

### Extension Structure
- **Main Entry Point**: `src/extension.ts` - Registers the custom editor provider
- **Core Provider**: `src/jsonlViewerProvider.ts` - Handles JSONL parsing, UI rendering, and AI integration
- **Webview Interface**: HTML/CSS/JavaScript frontend embedded in VS Code

### Key Components

#### 1. Custom Editor Provider
```typescript
class JsonlViewerProvider implements vscode.CustomTextEditorProvider
```
- Handles JSONL file parsing and validation
- Manages column detection and expansion
- Provides search and replace functionality
- Integrates with OpenAI API for AI features

#### 2. Data Models
```typescript
interface JsonRow {
    [key: string]: any;
    _aiResponse?: string;
}

interface ColumnInfo {
    path: string;
    displayName: string;
    visible: boolean;
    isExpanded?: boolean;
    parentPath?: string;
}
```

## AI Integration Points

### 1. OpenAI API Integration

The extension includes built-in OpenAI API integration for processing JSONL data:

```typescript
private async askAI(question: string, model: string = 'gpt-4.1-mini') {
    // Processes each row with field reference syntax
    // {{fieldname.subname[0]}} gets replaced with actual values
}
```

**Field Reference Syntax**:
- `{{name}}` - Reference top-level fields
- `{{address.city}}` - Reference nested fields  
- `{{hobbies[0]}}` - Reference array elements

### 2. AI Response Storage
AI responses are stored in the `_aiResponse` field of each JSON row and displayed in a dedicated column.

## Agent Integration Patterns

### 1. Direct Extension Modification

Agents can modify the extension source code to add new features:

#### Adding New AI Providers
```typescript
// In jsonlViewerProvider.ts
private async askClaude(question: string, model: string) {
    // Add Anthropic Claude integration
}

private async askGemini(question: string, model: string) {
    // Add Google Gemini integration
}
```

#### Custom Data Processing
```typescript
private async processWithCustomAgent(data: JsonRow[], prompt: string) {
    // Send data to custom AI agent endpoint
    // Process responses and update rows
}
```

### 2. Webview Message Extension

The webview communicates with the extension via message passing. Agents can extend this:

```typescript
// Add new message types
case 'customAgentRequest':
    await this.handleCustomAgentRequest(message);
    break;
```

### 3. External Agent Integration

#### HTTP API Integration
```typescript
private async callExternalAgent(endpoint: string, data: any) {
    const response = await axios.post(endpoint, {
        data: data,
        prompt: this.currentPrompt
    });
    return response.data;
}
```

#### WebSocket Integration
```typescript
private setupWebSocketAgent() {
    const ws = new WebSocket('ws://agent-server:8080');
    ws.onmessage = (event) => {
        const response = JSON.parse(event.data);
        this.updateRowsWithAgentResponse(response);
    };
}
```

## Extension Points for Agents

### 1. Custom Column Processors

```typescript
interface CustomColumnProcessor {
    name: string;
    process(value: any): string;
}

private customProcessors: CustomColumnProcessor[] = [
    {
        name: 'sentiment',
        process: (value) => this.analyzeSentiment(value)
    }
];
```

### 2. Data Validation Agents

```typescript
interface ValidationAgent {
    validate(row: JsonRow): ValidationResult;
}

private validationAgents: ValidationAgent[] = [
    {
        validate: (row) => this.validateSchema(row)
    }
];
```

### 3. Export Format Extensions

```typescript
private async exportToCustomFormat(format: string) {
    switch (format) {
        case 'parquet':
            return this.exportToParquet();
        case 'avro':
            return this.exportToAvro();
    }
}
```

## Agent Development Guidelines

### 1. Message Handling Pattern

```typescript
webviewPanel.webview.onDidReceiveMessage(async (message) => {
    switch (message.type) {
        case 'agentRequest':
            await this.handleAgentRequest(message);
            break;
        // ... existing cases
    }
});
```

### 2. Data Processing Pattern

```typescript
private async processWithAgent(data: JsonRow[], agentConfig: AgentConfig) {
    const results = await Promise.all(
        data.map(row => this.callAgent(row, agentConfig))
    );
    
    data.forEach((row, index) => {
        row._agentResponse = results[index];
    });
    
    this.updateWebview(webviewPanel);
}
```

### 3. Error Handling

```typescript
private async safeAgentCall(agentFunction: () => Promise<any>) {
    try {
        return await agentFunction();
    } catch (error) {
        vscode.window.showErrorMessage(`Agent error: ${error.message}`);
        console.error('Agent error:', error);
    }
}
```

## Configuration for Agents

### 1. Settings Extension

```typescript
// In package.json
"contributes": {
    "configuration": {
        "properties": {
            "jsonl-gazelle.agentEndpoints": {
                "type": "array",
                "default": [],
                "description": "Custom agent endpoints"
            },
            "jsonl-gazelle.agentTimeout": {
                "type": "number",
                "default": 30000,
                "description": "Agent request timeout in milliseconds"
            }
        }
    }
}
```

### 2. Agent Registry

```typescript
interface AgentRegistry {
    [agentName: string]: {
        endpoint: string;
        models: string[];
        capabilities: string[];
    };
}
```

## Use Cases for AI Agents

### 1. Data Analysis Agents
- **Sentiment Analysis**: Analyze text fields for sentiment
- **Classification**: Categorize rows based on content
- **Anomaly Detection**: Identify unusual patterns in data

### 2. Data Transformation Agents
- **Schema Mapping**: Convert between different data schemas
- **Data Cleaning**: Standardize and clean data fields
- **Enrichment**: Add additional data from external sources

### 3. Quality Assurance Agents
- **Validation**: Ensure data meets specific criteria
- **Completeness Check**: Verify required fields are present
- **Consistency Check**: Ensure data consistency across rows

### 4. Export/Import Agents
- **Format Conversion**: Convert to different data formats
- **API Integration**: Push data to external APIs
- **Database Sync**: Synchronize with databases

## Example Agent Implementation

### Basic Agent Integration

```typescript
class CustomAgent {
    constructor(private provider: JsonlViewerProvider) {}
    
    async processRows(rows: JsonRow[], prompt: string): Promise<void> {
        for (const row of rows) {
            try {
                const response = await this.callAgentAPI(row, prompt);
                row._customAgentResponse = response;
            } catch (error) {
                row._customAgentError = error.message;
            }
        }
        
        this.provider.updateWebview();
    }
    
    private async callAgentAPI(row: JsonRow, prompt: string): Promise<string> {
        const response = await axios.post('http://agent-server:8080/process', {
            data: row,
            prompt: prompt
        });
        return response.data.result;
    }
}
```

### Advanced Agent with Streaming

```typescript
class StreamingAgent {
    async processRowsStreaming(rows: JsonRow[], prompt: string): Promise<void> {
        const stream = await this.createStream(prompt);
        
        stream.on('data', (chunk) => {
            const { rowIndex, response } = JSON.parse(chunk);
            rows[rowIndex]._streamingResponse = response;
            this.provider.updateWebview();
        });
        
        stream.on('end', () => {
            console.log('Streaming complete');
        });
    }
}
```

## Testing Agent Integration

### 1. Unit Tests

```typescript
describe('Agent Integration', () => {
    it('should process rows with custom agent', async () => {
        const provider = new JsonlViewerProvider(context);
        const agent = new CustomAgent(provider);
        
        const testRows = [{ name: 'test', value: 123 }];
        await agent.processRows(testRows, 'analyze this data');
        
        expect(testRows[0]._customAgentResponse).toBeDefined();
    });
});
```

### 2. Integration Tests

```typescript
describe('Agent WebSocket Integration', () => {
    it('should handle real-time agent responses', async () => {
        const ws = new WebSocket('ws://test-agent:8080');
        // Test WebSocket communication
    });
});
```

## Security Considerations

### 1. API Key Management
- Store agent API keys securely in VS Code settings
- Use environment variables for sensitive configuration
- Implement key rotation mechanisms

### 2. Data Privacy
- Ensure agent endpoints are trusted
- Implement data sanitization before sending to external agents
- Add opt-in consent for data processing

### 3. Rate Limiting
- Implement request throttling for agent calls
- Add circuit breakers for failing agent endpoints
- Monitor agent usage and costs

## Performance Optimization

### 1. Batch Processing
```typescript
private async processBatch(rows: JsonRow[], batchSize: number = 10) {
    for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        await this.processBatchWithAgent(batch);
    }
}
```

### 2. Caching
```typescript
private agentResponseCache = new Map<string, any>();

private async getCachedResponse(key: string, agentCall: () => Promise<any>) {
    if (this.agentResponseCache.has(key)) {
        return this.agentResponseCache.get(key);
    }
    
    const response = await agentCall();
    this.agentResponseCache.set(key, response);
    return response;
}
```

## Future Extensions

### 1. Multi-Agent Orchestration
- Chain multiple agents for complex processing
- Implement agent selection based on data characteristics
- Add agent performance monitoring

### 2. Real-time Collaboration
- Share agent results across team members
- Implement collaborative agent configuration
- Add agent result versioning

### 3. Advanced Analytics
- Track agent performance metrics
- Implement A/B testing for different agents
- Add cost analysis for agent usage

## Conclusion

JSONL Gazelle provides a robust foundation for AI agent integration through its flexible architecture, comprehensive data handling, and extensible webview interface. Agents can be integrated at multiple levels, from simple API calls to complex streaming and real-time processing scenarios.

The extension's built-in AI integration serves as a template for more sophisticated agent implementations, while the message-passing architecture allows for seamless extension without modifying core functionality.

For more information about extending JSONL Gazelle with custom agents, refer to the main [README.md](README.md) and explore the source code in the `src/` directory.

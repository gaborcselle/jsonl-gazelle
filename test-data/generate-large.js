#!/usr/bin/env node

/**
 * JSONL Large Test Data Generator
 * 
 * This script generates a large JSONL file with 10,000 lines containing
 * varied fields including nested objects, arrays, and different data types.
 * The target file size is approximately 64MB.
 * 
 * Usage: node generate-large.js
 */

const fs = require('fs');
const path = require('path');

// Configuration
const TARGET_LINES = 45000;
const TARGET_SIZE_MB = 64;
const OUTPUT_FILE = path.join(__dirname, 'large.jsonl');

// Sample data pools for generating varied content
const firstNames = [
    'Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Henry',
    'Ivy', 'Jack', 'Kate', 'Liam', 'Maya', 'Noah', 'Olivia', 'Paul',
    'Quinn', 'Ruby', 'Sam', 'Tara', 'Uma', 'Victor', 'Wendy', 'Xavier',
    'Yara', 'Zoe', 'Aaron', 'Beth', 'Carl', 'Dora', 'Ethan', 'Fiona'
];

const lastNames = [
    'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller',
    'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez',
    'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin',
    'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark',
    'Ramirez', 'Lewis', 'Robinson', 'Walker', 'Young', 'Allen', 'King'
];

const cities = [
    'New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Philadelphia',
    'San Antonio', 'San Diego', 'Dallas', 'San Jose', 'Austin', 'Jacksonville',
    'Fort Worth', 'Columbus', 'Charlotte', 'San Francisco', 'Indianapolis',
    'Seattle', 'Denver', 'Washington', 'Boston', 'El Paso', 'Nashville',
    'Detroit', 'Oklahoma City', 'Portland', 'Las Vegas', 'Memphis', 'Louisville'
];

const countries = [
    'United States', 'Canada', 'United Kingdom', 'Germany', 'France',
    'Italy', 'Spain', 'Netherlands', 'Sweden', 'Norway', 'Denmark',
    'Finland', 'Australia', 'Japan', 'South Korea', 'China', 'India',
    'Brazil', 'Mexico', 'Argentina', 'Chile', 'South Africa', 'Egypt'
];

const productCategories = [
    'Electronics', 'Clothing', 'Books', 'Home & Garden', 'Sports',
    'Beauty', 'Toys', 'Automotive', 'Health', 'Food', 'Office',
    'Jewelry', 'Music', 'Movies', 'Software', 'Tools'
];

const statuses = ['active', 'inactive', 'pending', 'completed', 'cancelled', 'suspended'];
const priorities = ['low', 'medium', 'high', 'critical'];
const colors = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'black', 'white'];

// Utility functions
function randomChoice(array) {
    return array[Math.floor(Math.random() * array.length)];
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min, max, decimals = 2) {
    return parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
}

function randomBoolean() {
    return Math.random() < 0.5;
}

function randomDate(start = new Date(2020, 0, 1), end = new Date()) {
    return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
}

function generateRandomString(length = 10) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function generateRandomEmail() {
    const domains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'company.com'];
    return `${randomChoice(firstNames).toLowerCase()}.${randomChoice(lastNames).toLowerCase()}@${randomChoice(domains)}`;
}

function generateRandomPhone() {
    return `+1-${randomInt(200, 999)}-${randomInt(100, 999)}-${randomInt(1000, 9999)}`;
}

function generateAddress() {
    return {
        street: `${randomInt(1, 9999)} ${randomChoice(['Main', 'Oak', 'Pine', 'Elm', 'Cedar', 'Maple', 'First', 'Second', 'Third', 'Park'])} St`,
        city: randomChoice(cities),
        state: randomChoice(['CA', 'NY', 'TX', 'FL', 'IL', 'PA', 'OH', 'GA', 'NC', 'MI']),
        zipCode: randomInt(10000, 99999).toString(),
        country: randomChoice(countries),
        coordinates: {
            latitude: randomFloat(-90, 90),
            longitude: randomFloat(-180, 180)
        }
    };
}

function generateUserProfile() {
    return {
        firstName: randomChoice(firstNames),
        lastName: randomChoice(lastNames),
        email: generateRandomEmail(),
        phone: generateRandomPhone(),
        age: randomInt(18, 80),
        gender: randomChoice(['male', 'female', 'other', 'prefer_not_to_say']),
        address: generateAddress(),
        preferences: {
            theme: randomChoice(['light', 'dark', 'auto']),
            language: randomChoice(['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh']),
            notifications: {
                email: randomBoolean(),
                sms: randomBoolean(),
                push: randomBoolean()
            }
        },
        socialMedia: {
            twitter: randomBoolean() ? `@${randomChoice(firstNames).toLowerCase()}${randomInt(1, 999)}` : null,
            linkedin: randomBoolean() ? `linkedin.com/in/${randomChoice(firstNames).toLowerCase()}-${randomChoice(lastNames).toLowerCase()}` : null,
            github: randomBoolean() ? `github.com/${randomChoice(firstNames).toLowerCase()}${randomInt(1, 999)}` : null
        },
        tags: Array.from({ length: randomInt(1, 5) }, () => randomChoice(['premium', 'basic', 'enterprise', 'trial', 'beta', 'vip', 'new', 'returning']))
    };
}

function generateOrder() {
    const itemCount = randomInt(1, 10);
    const items = Array.from({ length: itemCount }, () => ({
        id: `item_${randomInt(1000, 9999)}`,
        name: `${randomChoice(['Premium', 'Deluxe', 'Standard', 'Basic', 'Pro', 'Elite'])} ${randomChoice(productCategories)}`,
        category: randomChoice(productCategories),
        price: randomFloat(5.99, 999.99),
        quantity: randomInt(1, 5),
        weight: randomFloat(0.1, 50.0),
        dimensions: {
            length: randomFloat(1, 100),
            width: randomFloat(1, 100),
            height: randomFloat(1, 100),
            unit: 'inches'
        },
        attributes: {
            color: randomChoice(colors),
            material: randomChoice(['cotton', 'polyester', 'metal', 'plastic', 'wood', 'glass', 'leather']),
            brand: randomChoice(['BrandA', 'BrandB', 'BrandC', 'Generic', 'Premium']),
            warranty: randomChoice(['1 year', '2 years', '5 years', 'lifetime', 'none'])
        }
    }));

    const subtotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const tax = subtotal * 0.08; // 8% tax
    const shipping = randomFloat(0, 25.99);
    const total = subtotal + tax + shipping;

    return {
        id: `order_${randomInt(100000, 999999)}`,
        items: items,
        pricing: {
            subtotal: parseFloat(subtotal.toFixed(2)),
            tax: parseFloat(tax.toFixed(2)),
            shipping: parseFloat(shipping.toFixed(2)),
            total: parseFloat(total.toFixed(2)),
            currency: 'USD'
        },
        status: randomChoice(statuses),
        priority: randomChoice(priorities),
        createdAt: randomDate(),
        estimatedDelivery: randomDate(new Date(), new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)),
        shippingAddress: generateAddress(),
        tracking: {
            carrier: randomChoice(['UPS', 'FedEx', 'USPS', 'DHL']),
            trackingNumber: `TRK${randomInt(100000000, 999999999)}`,
            status: randomChoice(['shipped', 'in_transit', 'out_for_delivery', 'delivered', 'exception'])
        }
    };
}

function generateAnalytics() {
    return {
        pageViews: randomInt(1, 10000),
        uniqueVisitors: randomInt(1, 5000),
        bounceRate: randomFloat(0.1, 0.9),
        sessionDuration: randomInt(30, 3600), // seconds
        conversionRate: randomFloat(0.01, 0.15),
        revenue: randomFloat(0, 10000),
        metrics: {
            clicks: randomInt(0, 1000),
            impressions: randomInt(100, 10000),
            ctr: randomFloat(0.01, 0.1), // click-through rate
            cpc: randomFloat(0.1, 5.0), // cost per click
            cpm: randomFloat(1.0, 50.0) // cost per mille
        },
        devices: {
            desktop: randomFloat(0.3, 0.7),
            mobile: randomFloat(0.2, 0.6),
            tablet: randomFloat(0.05, 0.3)
        },
        browsers: {
            chrome: randomFloat(0.4, 0.8),
            firefox: randomFloat(0.1, 0.3),
            safari: randomFloat(0.1, 0.4),
            edge: randomFloat(0.05, 0.2)
        }
    };
}

function generateLogEntry() {
    const logLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
    const services = ['auth-service', 'payment-service', 'user-service', 'notification-service', 'api-gateway'];
    const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
    const endpoints = ['/api/users', '/api/orders', '/api/products', '/api/auth', '/api/payments', '/api/notifications'];

    return {
        timestamp: randomDate(),
        level: randomChoice(logLevels),
        service: randomChoice(services),
        requestId: `req_${randomInt(100000, 999999)}`,
        method: randomChoice(methods),
        endpoint: randomChoice(endpoints),
        statusCode: randomChoice([200, 201, 400, 401, 403, 404, 500, 502, 503]),
        responseTime: randomInt(10, 5000), // milliseconds
        userAgent: `Mozilla/5.0 (${randomChoice(['Windows', 'Macintosh', 'Linux'])}) AppleWebKit/537.36`,
        ip: `${randomInt(1, 255)}.${randomInt(1, 255)}.${randomInt(1, 255)}.${randomInt(1, 255)}`,
        userId: randomBoolean() ? `user_${randomInt(1000, 9999)}` : null,
        sessionId: `session_${randomInt(100000, 999999)}`,
        metadata: {
            version: `v${randomInt(1, 3)}.${randomInt(0, 9)}.${randomInt(0, 9)}`,
            environment: randomChoice(['development', 'staging', 'production']),
            region: randomChoice(['us-east', 'us-west', 'eu-west', 'ap-southeast']),
            datacenter: randomChoice(['dc1', 'dc2', 'dc3'])
        },
        error: randomBoolean() ? {
            message: randomChoice([
                'Database connection timeout',
                'Invalid authentication token',
                'Resource not found',
                'Rate limit exceeded',
                'Internal server error'
            ]),
            stack: `Error: ${randomChoice(['ConnectionError', 'ValidationError', 'NotFoundError', 'RateLimitError'])}\n    at ${randomChoice(['auth.js', 'payment.js', 'user.js'])}:${randomInt(10, 100)}:${randomInt(10, 50)}`
        } : null
    };
}

function generateRandomRecord() {
    const recordTypes = ['user', 'order', 'analytics', 'log'];
    const recordType = randomChoice(recordTypes);

    const baseRecord = {
        id: `${recordType}_${randomInt(100000, 999999)}`,
        type: recordType,
        createdAt: randomDate(),
        updatedAt: randomDate(),
        version: randomInt(1, 10),
        active: randomBoolean(),
        metadata: {
            source: randomChoice(['web', 'mobile', 'api', 'batch', 'manual']),
            processed: randomBoolean(),
            validated: randomBoolean(),
            archived: randomBoolean()
        }
    };

    switch (recordType) {
        case 'user':
            return {
                ...baseRecord,
                profile: generateUserProfile(),
                orders: Array.from({ length: randomInt(0, 5) }, () => generateOrder()),
                analytics: generateAnalytics(),
                lastLogin: randomDate(),
                loginCount: randomInt(0, 1000),
                preferences: {
                    newsletter: randomBoolean(),
                    marketing: randomBoolean(),
                    privacy: randomChoice(['public', 'private', 'friends_only'])
                }
            };

        case 'order':
            return {
                ...baseRecord,
                order: generateOrder(),
                customer: generateUserProfile(),
                analytics: generateAnalytics(),
                fulfillment: {
                    warehouse: randomChoice(['warehouse_a', 'warehouse_b', 'warehouse_c']),
                    picker: `picker_${randomInt(1, 100)}`,
                    packer: `packer_${randomInt(1, 100)}`,
                    shipper: `shipper_${randomInt(1, 100)}`
                }
            };

        case 'analytics':
            return {
                ...baseRecord,
                analytics: generateAnalytics(),
                campaign: {
                    id: `campaign_${randomInt(1000, 9999)}`,
                    name: `${randomChoice(['Summer', 'Winter', 'Spring', 'Fall'])} ${randomChoice(['Sale', 'Promotion', 'Event', 'Launch'])}`,
                    budget: randomFloat(1000, 100000),
                    startDate: randomDate(),
                    endDate: randomDate()
                },
                audience: {
                    demographics: {
                        ageRange: `${randomInt(18, 25)}-${randomInt(26, 65)}`,
                        gender: randomChoice(['all', 'male', 'female']),
                        location: randomChoice(cities)
                    },
                    interests: Array.from({ length: randomInt(3, 8) }, () => randomChoice(productCategories))
                }
            };

        case 'log':
            return {
                ...baseRecord,
                log: generateLogEntry(),
                context: {
                    userId: randomBoolean() ? `user_${randomInt(1000, 9999)}` : null,
                    sessionId: `session_${randomInt(100000, 999999)}`,
                    correlationId: `corr_${randomInt(100000, 999999)}`,
                    traceId: `trace_${randomInt(100000, 999999)}`
                },
                performance: {
                    cpuUsage: randomFloat(0.1, 1.0),
                    memoryUsage: randomFloat(0.1, 1.0),
                    diskUsage: randomFloat(0.1, 1.0),
                    networkLatency: randomInt(1, 1000)
                }
            };

        default:
            return baseRecord;
    }
}

// Main generation function
function generateLargeJsonl() {
    console.log(`Generating ${TARGET_LINES} lines of JSONL data...`);
    console.log(`Target file: ${OUTPUT_FILE}`);
    console.log(`Target size: ~${TARGET_SIZE_MB}MB`);
    console.log('');

    const startTime = Date.now();
    const writeStream = fs.createWriteStream(OUTPUT_FILE);
    
    let lineCount = 0;
    let totalBytes = 0;
    const targetBytes = TARGET_SIZE_MB * 1024 * 1024;

    writeStream.on('error', (err) => {
        console.error('Error writing file:', err);
        process.exit(1);
    });

    // Generate records in batches to manage memory
    const batchSize = 100;
    let batch = [];

    function writeBatch() {
        if (batch.length === 0) return;

        const batchJson = batch.map(record => JSON.stringify(record)).join('\n') + '\n';
        const batchBytes = Buffer.byteLength(batchJson, 'utf8');
        
        writeStream.write(batchJson);
        totalBytes += batchBytes;
        lineCount += batch.length;
        batch = [];

        // Progress indicator
        if (lineCount % 1000 === 0) {
            const progress = ((lineCount / TARGET_LINES) * 100).toFixed(1);
            const currentSizeMB = (totalBytes / (1024 * 1024)).toFixed(2);
            console.log(`Progress: ${lineCount}/${TARGET_LINES} lines (${progress}%) - ${currentSizeMB}MB`);
        }
    }

    // Generate all records
    for (let i = 0; i < TARGET_LINES; i++) {
        const record = generateRandomRecord();
        batch.push(record);

        if (batch.length >= batchSize) {
            writeBatch();
        }

        // Stop if we've reached the target size
        if (totalBytes >= targetBytes) {
            console.log(`Reached target size of ${TARGET_SIZE_MB}MB at line ${lineCount}`);
            break;
        }
    }

    // Write remaining records
    if (batch.length > 0) {
        writeBatch();
    }

    writeStream.end();

    writeStream.on('finish', () => {
        const endTime = Date.now();
        const duration = (endTime - startTime) / 1000;
        const finalSizeMB = (totalBytes / (1024 * 1024)).toFixed(2);
        
        console.log('');
        console.log('✅ Generation complete!');
        console.log(`📊 Generated ${lineCount} lines`);
        console.log(`📁 File size: ${finalSizeMB}MB`);
        console.log(`⏱️  Duration: ${duration.toFixed(2)} seconds`);
        console.log(`📄 Output file: ${OUTPUT_FILE}`);
        console.log('');
        console.log('The file contains varied data including:');
        console.log('- User profiles with nested addresses and preferences');
        console.log('- Orders with items, pricing, and shipping information');
        console.log('- Analytics data with metrics and device information');
        console.log('- Log entries with request details and error information');
        console.log('- Mixed data types: strings, numbers, booleans, arrays, objects');
        console.log('- Nested structures up to 4-5 levels deep');
    });
}

// Run the generator
if (require.main === module) {
    generateLargeJsonl();
}

module.exports = { generateLargeJsonl };

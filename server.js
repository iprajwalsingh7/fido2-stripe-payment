// server.js - Node.js Backend for FIDO2 + Stripe Payment System
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); // Replace with your secret key
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public')); // Serve static files

// In-memory storage
const users = new Map();
const paymentIntents = new Map();

// Routes

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Create Payment Intent
app.post('/api/create-payment-intent', async (req, res) => {
    try {
        const { amount, currency = 'usd', description, customer_name, payment_method_type } = req.body;

        if (!amount || !description || !customer_name) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Create customer in Stripe
        const customer = await stripe.customers.create({
            name: customer_name,
            description: `Customer for ${description}`,
        });

        // Payment method types based on selection
        const paymentMethodTypes = payment_method_type === 'us_bank_account' 
            ? ['us_bank_account'] 
            : ['card'];

        // Create Payment Intent
        const paymentIntent = await stripe.paymentIntents.create({
            amount: amount, // Amount in cents
            currency: currency,
            customer: customer.id,
            description: description,
            payment_method_types: paymentMethodTypes,
            metadata: {
                customer_name: customer_name,
                description: description
            }
        });

        // Store payment intent for tracking
        paymentIntents.set(paymentIntent.id, {
            id: paymentIntent.id,
            amount: amount,
            currency: currency,
            customer_name: customer_name,
            description: description,
            status: paymentIntent.status,
            created: new Date().toISOString()
        });

        res.json({
            client_secret: paymentIntent.client_secret,
            payment_intent_id: paymentIntent.id,
            customer_id: customer.id
        });

    } catch (error) {
        console.error('Error creating payment intent:', error);
        res.status(500).json({ error: error.message });
    }
});

// Confirm Payment Intent (for additional verification)
app.post('/api/confirm-payment', async (req, res) => {
    try {
        const { payment_intent_id, payment_method_id } = req.body;

        const paymentIntent = await stripe.paymentIntents.confirm(payment_intent_id, {
            payment_method: payment_method_id
        });

        // Update our tracking
        if (paymentIntents.has(payment_intent_id)) {
            const stored = paymentIntents.get(payment_intent_id);
            stored.status = paymentIntent.status;
            stored.confirmed_at = new Date().toISOString();
            paymentIntents.set(payment_intent_id, stored);
        }

        res.json({
            status: paymentIntent.status,
            payment_intent: paymentIntent
        });

    } catch (error) {
        console.error('Error confirming payment:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get Payment Status
app.get('/api/payment-status/:payment_intent_id', async (req, res) => {
    try {
        const { payment_intent_id } = req.params;
        
        const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);
        
        res.json({
            id: paymentIntent.id,
            status: paymentIntent.status,
            amount: paymentIntent.amount,
            currency: paymentIntent.currency,
            created: paymentIntent.created,
            metadata: paymentIntent.metadata
        });

    } catch (error) {
        console.error('Error retrieving payment status:', error);
        res.status(500).json({ error: error.message });
    }
});

// FIDO2/WebAuthn Registration Endpoint
app.post('/api/register-credential', async (req, res) => {
    try {
        const { username, email, credential_data } = req.body;

        if (!username || !email || !credential_data) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Store user credential (in production, use a secure database)
        users.set(username, {
            username,
            email,
            credential_id: credential_data.credentialId,
            public_key: credential_data.publicKey,
            counter: credential_data.counter || 0,
            registered_at: new Date().toISOString()
        });

        res.json({ 
            success: true, 
            message: 'Credential registered successfully',
            user_id: username
        });

    } catch (error) {
        console.error('Error registering credential:', error);
        res.status(500).json({ error: error.message });
    }
});

// FIDO2/WebAuthn Authentication Verification
app.post('/api/verify-authentication', async (req, res) => {
    try {
        const { username, authentication_data } = req.body;

        if (!username || !authentication_data) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const user = users.get(username);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // In production, properly verify the authentication assertion
        // This is a simplified version - you'd want to use a proper WebAuthn library
        
        res.json({ 
            success: true, 
            message: 'Authentication verified successfully',
            user_id: username
        });

    } catch (error) {
        console.error('Error verifying authentication:', error);
        res.status(500).json({ error: error.message });
    }
});

// Webhook handler for Stripe events
app.post('/api/webhook', bodyParser.raw({type: 'application/json'}), (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = 'whsec_your_webhook_secret_here'; // Replace with your webhook secret

    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        console.log(`Webhook signature verification failed.`, err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
        case 'payment_intent.succeeded':
            const paymentIntent = event.data.object;
            console.log('Payment succeeded:', paymentIntent.id);
            
            // Update payment status in your database
            if (paymentIntents.has(paymentIntent.id)) {
                const stored = paymentIntents.get(paymentIntent.id);
                stored.status = 'succeeded';
                stored.completed_at = new Date().toISOString();
                paymentIntents.set(paymentIntent.id, stored);
            }
            break;

        case 'payment_intent.payment_failed':
            const failedPayment = event.data.object;
            console.log('Payment failed:', failedPayment.id);
            
            if (paymentIntents.has(failedPayment.id)) {
                const stored = paymentIntents.get(failedPayment.id);
                stored.status = 'failed';
                stored.failed_at = new Date().toISOString();
                paymentIntents.set(failedPayment.id, stored);
            }
            break;

        case 'payment_intent.processing':
            const processingPayment = event.data.object;
            console.log('Payment processing:', processingPayment.id);
            break;

        default:
            console.log(`Unhandled event type ${event.type}`);
    }

    res.json({received: true});
});

// Get all payments (for admin/dashboard)
app.get('/api/payments', (req, res) => {
    const payments = Array.from(paymentIntents.values());
    res.json(payments);
});

// Get user info
app.get('/api/user/:username', (req, res) => {
    const { username } = req.params;
    const user = users.get(username);
    
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }

    // Don't send sensitive credential data
    res.json({
        username: user.username,
        email: user.email,
        registered_at: user.registered_at
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 SecurePay server running on port ${PORT}`);
    console.log(`📱 Frontend: http://localhost:${PORT}`);
    console.log(`🔧 API: http://localhost:${PORT}/api`);
});

module.exports = app;
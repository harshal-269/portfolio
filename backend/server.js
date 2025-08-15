const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:8080',
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// Contact form rate limiting (more restrictive)
const contactLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5, // limit each IP to 5 contact form submissions per hour
    message: 'Too many contact form submissions, please try again later.'
});

// MongoDB connection (optional - for storing messages)
if (process.env.MONGODB_URI) {
    mongoose.connect(process.env.MONGODB_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
    }).then(() => {
        console.log('Connected to MongoDB');
    }).catch((error) => {
        console.error('MongoDB connection error:', error);
    });

    // Contact message schema
    const contactSchema = new mongoose.Schema({
        name: { type: String, required: true },
        email: { type: String, required: true },
        message: { type: String, required: true },
        timestamp: { type: Date, default: Date.now },
        ip: String
    });

    const Contact = mongoose.model('Contact', contactSchema);
}

// Email transporter setup
const transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Verify email configuration
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    transporter.verify((error, success) => {
        if (error) {
            console.error('Email configuration error:', error);
        } else {
            console.log('Email server is ready to take our messages');
        }
    });
}

// Routes

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.status(200).json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Contact form endpoint
app.post('/api/contact', contactLimiter, async (req, res) => {
    try {
        const { name, email, message } = req.body;

        // Input validation
        if (!name || !email || !message) {
            return res.status(400).json({ 
                error: 'All fields are required' 
            });
        }

        // Email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ 
                error: 'Invalid email format' 
            });
        }

        // Save to database if MongoDB is connected
        if (mongoose.connection.readyState === 1) {
            const contactMessage = new Contact({
                name,
                email,
                message,
                ip: req.ip
            });
            await contactMessage.save();
        }

        // Send email notification
        if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
            const mailOptions = {
                from: process.env.EMAIL_USER,
                to: process.env.NOTIFY_EMAIL || process.env.EMAIL_USER,
                subject: `Portfolio Contact Form: Message from ${name}`,
                html: `
                    <h3>New Contact Form Submission</h3>
                    <p><strong>Name:</strong> ${name}</p>
                    <p><strong>Email:</strong> ${email}</p>
                    <p><strong>Message:</strong></p>
                    <p>${message.replace(/\n/g, '<br>')}</p>
                    <p><strong>Timestamp:</strong> ${new Date().toLocaleString()}</p>
                `
            };

            // Auto-reply to sender
            const autoReply = {
                from: process.env.EMAIL_USER,
                to: email,
                subject: 'Thank you for your message!',
                html: `
                    <h3>Thank you for contacting me!</h3>
                    <p>Hi ${name},</p>
                    <p>Thank you for reaching out. I have received your message and will get back to you as soon as possible.</p>
                    <p>Best regards,<br>Your Name</p>
                    <hr>
                    <p><em>This is an automated response. Please do not reply to this email.</em></p>
                `
            };

            await transporter.sendMail(mailOptions);
            await transporter.sendMail(autoReply);
        }

        res.status(200).json({ 
            message: 'Message sent successfully',
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Contact form error:', error);
        res.status(500).json({ 
            error: 'Internal server error. Please try again later.' 
        });
    }
});

// Get portfolio stats endpoint (optional)
app.get('/api/stats', async (req, res) => {
    try {
        let stats = {
            totalVisits: 0,
            totalMessages: 0,
            lastUpdated: new Date().toISOString()
        };

        if (mongoose.connection.readyState === 1) {
            const Contact = mongoose.model('Contact');
            stats.totalMessages = await Contact.countDocuments();
        }

        res.status(200).json(stats);
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ error: 'Could not fetch stats' });
    }
});

// Admin endpoint to get messages (basic auth required)
app.get('/api/admin/messages', async (req, res) => {
    try {
        // Basic authentication
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const token = authHeader.split(' ')[1];
        if (token !== process.env.ADMIN_TOKEN) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        if (mongoose.connection.readyState === 1) {
            const Contact = mongoose.model('Contact');
            const messages = await Contact.find()
                .sort({ timestamp: -1 })
                .limit(50);
            
            res.status(200).json(messages);
        } else {
            res.status(503).json({ error: 'Database not available' });
        }
    } catch (error) {
        console.error('Admin messages error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({ 
        error: 'Route not found',
        path: req.originalUrl 
    });
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ 
        error: 'Something went wrong!',
        ...(process.env.NODE_ENV === 'development' && { details: error.message })
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`Portfolio backend server is running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Email configured: ${process.env.EMAIL_USER ? 'Yes' : 'No'}`);
    console.log(`Database configured: ${process.env.MONGODB_URI ? 'Yes' : 'No'}`);
});

module.exports = app;
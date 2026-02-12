// Script to create initial admin user
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const User = require('../models/User');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

async function createAdmin() {
  try {
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
      console.error('Missing ADMIN_EMAIL and/or ADMIN_PASSWORD environment variables.');
      process.exit(1);
    }

    // Connect to MongoDB
    const mongoUri = process.env.NODE_ENV === 'production'
      ? process.env.MONGO_PROD_URI
      : (process.env.MONGO_DEV_URI || 'mongodb://127.0.0.1:27017/arxcafe');

    if (!mongoUri) {
      console.error('Missing MongoDB URI. Set MONGO_PROD_URI (NODE_ENV=production) or MONGO_DEV_URI.');
      process.exit(1);
    }

    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    // Check if admin already exists
    const existingAdmin = await User.findOne({ email: ADMIN_EMAIL });
    if (existingAdmin) {
      console.log('Admin user already exists:', ADMIN_EMAIL);
      
      // Update password if not set
      if (!existingAdmin.password_hash) {
        const password_hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
        existingAdmin.password_hash = password_hash;
        existingAdmin.role = 'admin';
        await existingAdmin.save();
        console.log('✅ Password updated for existing admin');
        console.log('Email:', ADMIN_EMAIL);
        console.log('Password was set from ADMIN_PASSWORD env var.');
      } else if (existingAdmin.role !== 'admin') {
        existingAdmin.role = 'admin';
        await existingAdmin.save();
        console.log('Updated user role to admin');
      }
      
      process.exit(0);
    }

    // Create admin user
    const password_hash = await bcrypt.hash(ADMIN_PASSWORD, 10);

    const admin = new User({
      email: ADMIN_EMAIL,
      password_hash,
      role: 'admin'
    });

    await admin.save();

    console.log('✅ Admin user created successfully!');
    console.log('Email:', ADMIN_EMAIL);
    console.log('Password was set from ADMIN_PASSWORD env var.');

    process.exit(0);
  } catch (err) {
    console.error('Error creating admin:', err);
    process.exit(1);
  }
}

createAdmin();

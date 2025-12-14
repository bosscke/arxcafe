// Initialize ArxCafe database with sample data
db = db.getSiblingDB('arxcafe');

db.createCollection('menuitems');

db.menuitems.insertMany([
  {
    name: 'Espresso',
    description: 'Strong and bold Italian coffee',
    price: 2.50,
    category: 'coffee',
    available: true,
    createdAt: new Date(),
    updatedAt: new Date()
  },
  {
    name: 'Cappuccino',
    description: 'Espresso with steamed milk foam',
    price: 3.50,
    category: 'coffee',
    available: true,
    createdAt: new Date(),
    updatedAt: new Date()
  },
  {
    name: 'Latte',
    description: 'Espresso with steamed milk',
    price: 4.00,
    category: 'coffee',
    available: true,
    createdAt: new Date(),
    updatedAt: new Date()
  },
  {
    name: 'Americano',
    description: 'Espresso with hot water',
    price: 2.75,
    category: 'coffee',
    available: true,
    createdAt: new Date(),
    updatedAt: new Date()
  },
  {
    name: 'Green Tea',
    description: 'Fresh brewed green tea',
    price: 2.00,
    category: 'tea',
    available: true,
    createdAt: new Date(),
    updatedAt: new Date()
  },
  {
    name: 'Croissant',
    description: 'Buttery French pastry',
    price: 3.00,
    category: 'pastry',
    available: true,
    createdAt: new Date(),
    updatedAt: new Date()
  }
]);

print('Database initialized with sample menu items');

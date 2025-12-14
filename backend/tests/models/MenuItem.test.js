const MenuItem = require('../models/MenuItem');

describe('MenuItem Model', () => {
  test('should create a valid menu item', () => {
    const itemData = {
      name: 'Espresso',
      description: 'Strong coffee',
      price: 2.50,
      category: 'coffee'
    };

    const item = new MenuItem(itemData);
    const validation = item.validateSync();
    
    expect(validation).toBeUndefined();
    expect(item.name).toBe('Espresso');
    expect(item.price).toBe(2.50);
  });

  test('should require name field', () => {
    const item = new MenuItem({
      description: 'Test',
      price: 1.00
    });

    const validation = item.validateSync();
    expect(validation.errors.name).toBeDefined();
  });

  test('should require description field', () => {
    const item = new MenuItem({
      name: 'Test',
      price: 1.00
    });

    const validation = item.validateSync();
    expect(validation.errors.description).toBeDefined();
  });

  test('should require price field', () => {
    const item = new MenuItem({
      name: 'Test',
      description: 'Test description'
    });

    const validation = item.validateSync();
    expect(validation.errors.price).toBeDefined();
  });

  test('should enforce minimum price of 0', () => {
    const item = new MenuItem({
      name: 'Test',
      description: 'Test',
      price: -1
    });

    const validation = item.validateSync();
    expect(validation.errors.price).toBeDefined();
  });

  test('should default available to true', () => {
    const item = new MenuItem({
      name: 'Test',
      description: 'Test',
      price: 1.00
    });

    expect(item.available).toBe(true);
  });

  test('should validate category enum', () => {
    const item = new MenuItem({
      name: 'Test',
      description: 'Test',
      price: 1.00,
      category: 'invalid'
    });

    const validation = item.validateSync();
    expect(validation.errors.category).toBeDefined();
  });
});

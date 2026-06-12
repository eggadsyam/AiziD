import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';

dotenv.config();

const dbUrl = process.env.DATABASE_URL || 'sqlite://database.db';
let sequelize;

if (dbUrl.startsWith('sqlite:')) {
  // Extract file path from sqlite:///database.db or sqlite://database.db
  const storage = dbUrl.replace(/^sqlite:\/\/\/?/, '') || 'database.db';
  sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: storage,
    logging: false,
    define: {
      timestamps: false // matching SQLAlchemy models
    }
  });
} else {
  // Support both postgres:// and postgresql://
  const normalizedUrl = dbUrl.replace(/^postgres:/, 'postgresql:');
  sequelize = new Sequelize(normalizedUrl, {
    dialect: 'postgres',
    dialectOptions: {
      ssl: normalizedUrl.includes('sslmode=require') || process.env.NODE_ENV === 'production' ? {
        require: true,
        rejectUnauthorized: false
      } : false
    },
    logging: false,
    define: {
      timestamps: false
    }
  });
}

export { sequelize };
export default sequelize;

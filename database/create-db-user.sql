-- Run once on the server PC as the MySQL root user:
--   mysql -u root -p < database/create-db-user.sql
-- Change the password, then put the same values in .env (development) or the server settings.

CREATE DATABASE IF NOT EXISTS grocery9010 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'pos_app'@'localhost' IDENTIFIED BY 'MyPassword123!';
GRANT ALL PRIVILEGES ON grocery9010.* TO 'pos_app'@'localhost';
FLUSH PRIVILEGES;
export const logger = {
  info: (message) => console.log(`${new Date().toISOString()} INFO  ${message}`),
  warn: (message) => console.warn(`${new Date().toISOString()} WARN  ${message}`),
  error: (message) => console.error(`${new Date().toISOString()} ERROR ${message}`),
};

FROM node:22-alpine

# Create app directory
WORKDIR /app

# Copy package files first
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy rest of the files
COPY . .

# Expose port (same as in your server.js)
EXPOSE 3000

# Start the chatbot
CMD ["npm", "start"]

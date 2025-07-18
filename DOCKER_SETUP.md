# AI Processor - VPS Docker Deployment Guide

This guide will help you migrate from Fly.io to VPS Docker deployment.

## Prerequisites on VPS

1. **Docker** installed on your VPS
2. **Docker Compose** installed
3. **OpenAI API Key** (already configured in `.env`)

## VPS Setup Instructions

### 1. Install Docker on VPS (Ubuntu/Debian)

```bash
# Update package index
sudo apt update

# Install Docker
sudo apt install -y docker.io docker-compose

# Start Docker service
sudo systemctl start docker
sudo systemctl enable docker

# Add your user to docker group (optional, to run without sudo)
sudo usermod -aG docker $USER
# Log out and back in for this to take effect
```

### 2. Upload Files to VPS

Upload all files from this directory to your VPS. You can use:
- SCP: `scp -r . user@your-vps-ip:/path/to/ai-processor/`
- SFTP client
- Git clone (if in a repository)

### 3. Deploy on VPS

SSH into your VPS and navigate to the project directory:

```bash
cd /path/to/ai-processor/

# Make scripts executable
chmod +x deploy-vps.sh stop-vps.sh

# Deploy the service
./deploy-vps.sh
```

### 4. Verify Deployment

The service will be available at: `http://your-vps-ip:8080`

Test from your VPS:
```bash
curl http://localhost:8080/health
```

Test from outside:
```bash
curl http://your-vps-ip:8080/health
```

## Management Commands

### Deploy/Restart Service
```bash
./deploy-vps.sh
```

### Stop Service
```bash
./stop-vps.sh
```

### View Logs
```bash
docker-compose logs -f
```

### Manual Docker Commands
```bash
# Build image
docker-compose build

# Start service
docker-compose up -d

# Stop service
docker-compose down

# View running containers
docker ps

# View container stats
docker stats
```

## Firewall Configuration

Make sure port 8080 is open on your VPS:

```bash
# UFW (Ubuntu)
sudo ufw allow 8080

# iptables
sudo iptables -A INPUT -p tcp --dport 8080 -j ACCEPT
```

## Updating Your Main Application

Update your main application's API endpoint from:
```
https://your-fly-app.fly.dev
```

To:
```
http://your-vps-ip:8080
```

## SSL/HTTPS Setup (Recommended)

For production, set up a reverse proxy with SSL:

### Option 1: Nginx + Let's Encrypt

1. Install nginx: `sudo apt install nginx certbot python3-certbot-nginx`
2. Configure nginx to proxy to port 8080
3. Get SSL certificate: `sudo certbot --nginx -d your-domain.com`

### Option 2: Cloudflare Tunnel

Use Cloudflare Tunnel to expose your service securely without opening ports.

## Troubleshooting

### Service Won't Start
```bash
# Check if port is available
sudo netstat -tlnp | grep 8080

# Check Docker logs
docker-compose logs

# Verify .env file exists and has API key
cat .env
```

### Can't Connect from Outside
1. Check VPS firewall: `sudo ufw status`
2. Check cloud provider security groups
3. Verify service is binding to 0.0.0.0: `docker-compose logs`

### Performance Issues
```bash
# Monitor container resources
docker stats

# Check VPS resources
free -h
df -h
top
```

## Auto-start on Boot

To start the service automatically when VPS reboots:

```bash
# Create systemd service
sudo tee /etc/systemd/system/ai-processor.service > /dev/null <<EOF
[Unit]
Description=AI Processor Docker Service
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/path/to/ai-processor
ExecStart=/usr/bin/docker-compose up -d
ExecStop=/usr/bin/docker-compose down

[Install]
WantedBy=multi-user.target
EOF

# Enable the service
sudo systemctl enable ai-processor.service
sudo systemctl start ai-processor.service
```

#!/bin/bash

# There is a commit-hook configured on GitHub. Repository gets pulled and app restarted on commit to 'master'

nohup githooked -p 9001 bash "git pull origin master; pm2 restart all" &

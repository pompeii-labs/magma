#!/bin/sh

# Install dependencies
npm install

# Install all hooks
cp hooks/* .git/hooks/
chmod +x .git/hooks/*

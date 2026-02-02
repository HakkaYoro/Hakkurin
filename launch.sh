#!/bin/bash

# Define virtual environment name
VENV_NAME="venv"

# Check if venv exists
if [ ! -d "$VENV_NAME" ]; then
    echo "Creating virtual environment..."
    python3 -m venv $VENV_NAME
fi

# Activate venv
echo "Activating virtual environment..."
source $VENV_NAME/bin/activate

# Install dependencies
echo "Installing/Updating dependencies..."
pip install -r requirements.txt

# Run the bot
echo "Starting Hakkurin Bot..."
python3 main.py

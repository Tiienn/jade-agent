#!/bin/zsh
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
python3 install_helper.py
if (( $? != 0 )); then
  read '?Setup failed. Press Return to close.'
fi

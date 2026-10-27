#!/usr/bin/env python3
"""Give the POC's Cognito test users permanent passwords, without ever printing them.

The invite email is suppressed in the stack, so the users start without a usable password.
This script generates one per user, sets it as permanent, and writes the pair to a local file
readable only by you:

    ~/.kirocrew-eks-poc/passwords.json    (mode 600, outside the repository)

Only the file path is printed. Open the file yourself when you need to sign in.
Re-running replaces the passwords.
"""
import json
import os
import secrets
import stat
import sys

import boto3

STACK = "kirocrew-eks-poc"
REGION = "us-east-1"
USERS = sys.argv[1:] or ["alice", "bob"]

cfn = boto3.client("cloudformation", region_name=REGION)
idp = boto3.client("cognito-idp", region_name=REGION)

outputs = {o["OutputKey"]: o["OutputValue"] for o in cfn.describe_stacks(StackName=STACK)["Stacks"][0]["Outputs"]}
pool_id = outputs["UserPoolId"]

out_dir = os.path.expanduser("~/.kirocrew-eks-poc")
os.makedirs(out_dir, mode=0o700, exist_ok=True)
path = os.path.join(out_dir, "passwords.json")

creds = {}
for name in USERS:
    # Meets the default Cognito policy: upper, lower, digit and symbol, plus high-entropy filler.
    password = "Aa1!" + secrets.token_urlsafe(18)
    idp.admin_set_user_password(UserPoolId=pool_id, Username=name, Password=password, Permanent=True)
    creds[name] = password

fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, stat.S_IRUSR | stat.S_IWUSR)
with os.fdopen(fd, "w") as fh:
    json.dump(creds, fh, indent=2)

print(f"Passwords set for {', '.join(USERS)}. File (mode 600): {path}")

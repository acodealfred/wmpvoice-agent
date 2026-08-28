#!/bin/bash

ENV_FILE_PATH="app/backend/.env"

# Helper: get a value from azd env, fall back to $2 if the key is missing or the
# output starts with "ERROR" (azd writes errors to stdout, not stderr).
azd_get() {
    local key="$1" default="$2"
    local val
    val=$(azd env get-value "$key" 2>/dev/null)
    if [[ -z "$val" || "$val" == ERROR* ]]; then
        echo "$default"
    else
        echo "$val"
    fi
}

# Clear and rewrite the env file
> "$ENV_FILE_PATH"

echo "AZURE_OPENAI_ENDPOINT=$(azd_get AZURE_OPENAI_ENDPOINT '')"                             >> "$ENV_FILE_PATH"
echo "AZURE_OPENAI_REALTIME_DEPLOYMENT=$(azd_get AZURE_OPENAI_REALTIME_DEPLOYMENT '')"       >> "$ENV_FILE_PATH"
echo "AZURE_OPENAI_REALTIME_VOICE_CHOICE=$(azd_get AZURE_OPENAI_REALTIME_VOICE_CHOICE '')"   >> "$ENV_FILE_PATH"
echo "AZURE_TENANT_ID=$(azd_get AZURE_TENANT_ID '')"                                         >> "$ENV_FILE_PATH"
echo "ENABLE_SENTIMENT_ANALYSIS=$(azd_get ENABLE_SENTIMENT_ANALYSIS 'true')"                 >> "$ENV_FILE_PATH"
echo "ENABLE_SURVEY_MODE=$(azd_get ENABLE_SURVEY_MODE 'true')"                               >> "$ENV_FILE_PATH"
echo "ENABLE_RECOVERY_WINDOW_VOICE=$(azd_get ENABLE_RECOVERY_WINDOW_VOICE 'true')"           >> "$ENV_FILE_PATH"
echo "AWS_REGION=$(azd_get AWS_REGION 'us-east-1')"                                          >> "$ENV_FILE_PATH"
echo "AWS_ACCESS_KEY_ID=$(azd_get AWS_ACCESS_KEY_ID '')"                                     >> "$ENV_FILE_PATH"
echo "AWS_SECRET_ACCESS_KEY=$(azd_get AWS_SECRET_ACCESS_KEY '')"                             >> "$ENV_FILE_PATH"
echo "MITHRA_API_BASE_URL=$(azd_get MITHRA_API_BASE_URL 'https://api.dev.mithra.shelterzoom.com')" >> "$ENV_FILE_PATH"
echo "MITHRA_APP_TOKEN=$(azd_get MITHRA_APP_TOKEN '')"                                       >> "$ENV_FILE_PATH"
echo "REPORT_OPENAI_ENDPOINT=$(azd_get REPORT_OPENAI_ENDPOINT '')"                           >> "$ENV_FILE_PATH"
echo "REPORT_OPENAI_API_KEY=$(azd_get REPORT_OPENAI_API_KEY '')"                             >> "$ENV_FILE_PATH"
echo "REPORT_OPENAI_DEPLOYMENT=$(azd_get REPORT_OPENAI_DEPLOYMENT 'gpt-4o')"                 >> "$ENV_FILE_PATH"

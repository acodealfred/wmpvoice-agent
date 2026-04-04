# Define the .env file path
$envFilePath = "app\backend\.env"

# Clear the contents of the .env file
Set-Content -Path $envFilePath -Value ""

# Append new values to the .env file
$azureOpenAiEndpoint = azd env get-value AZURE_OPENAI_ENDPOINT
$azureOpenAiRealtimeDeployment = azd env get-value AZURE_OPENAI_REALTIME_DEPLOYMENT
$azureOpenAiRealtimeVoiceChoice = azd env get-value AZURE_OPENAI_REALTIME_VOICE_CHOICE
$azureTenantId = azd env get-value AZURE_TENANT_ID
$enableSentimentAnalysis = azd env get-value ENABLE_SENTIMENT_ANALYSIS 2>$null
if (-not $enableSentimentAnalysis) { $enableSentimentAnalysis = "false" }
# RAG features disabled - AI Search env vars removed
# $azureSearchEndpoint = azd env get-value AZURE_SEARCH_ENDPOINT
# $azureSearchIndex = azd env get-value AZURE_SEARCH_INDEX
# $azureSearchSemanticConfiguration = azd env get-value AZURE_SEARCH_SEMANTIC_CONFIGURATION
# $azureSearchIdentifierField = azd env get-value AZURE_SEARCH_IDENTIFIER_FIELD
# $azureSearchTitleField = azd env get-value AZURE_SEARCH_TITLE_FIELD
# $azureSearchContentField = azd env get-value AZURE_SEARCH_CONTENT_FIELD
# $azureSearchEmbeddingField = azd env get-value AZURE_SEARCH_EMBEDDING_FIELD
# $azureSearchUseVectorQuery = azd env get-value AZURE_SEARCH_USE_VECTOR_QUERY

Add-Content -Path $envFilePath -Value "AZURE_OPENAI_ENDPOINT=$azureOpenAiEndpoint"
Add-Content -Path $envFilePath -Value "AZURE_OPENAI_REALTIME_DEPLOYMENT=$azureOpenAiRealtimeDeployment"
Add-Content -Path $envFilePath -Value "AZURE_OPENAI_REALTIME_VOICE_CHOICE=$azureOpenAiRealtimeVoiceChoice"
Add-Content -Path $envFilePath -Value "AZURE_TENANT_ID=$azureTenantId"
Add-Content -Path $envFilePath -Value "ENABLE_SENTIMENT_ANALYSIS=$enableSentimentAnalysis"
$awsRegion = azd env get-value AWS_REGION 2>$null
if (-not $awsRegion) { $awsRegion = "us-east-1" }
Add-Content -Path $envFilePath -Value "AWS_REGION=$awsRegion"
$awsAccessKeyId = azd env get-value AWS_ACCESS_KEY_ID 2>$null
if ($awsAccessKeyId) { Add-Content -Path $envFilePath -Value "AWS_ACCESS_KEY_ID=$awsAccessKeyId" }
$awsSecretAccessKey = azd env get-value AWS_SECRET_ACCESS_KEY 2>$null
if ($awsSecretAccessKey) { Add-Content -Path $envFilePath -Value "AWS_SECRET_ACCESS_KEY=$awsSecretAccessKey" }
# RAG features disabled - AI Search env vars removed
# Add-Content -Path $envFilePath -Value "AZURE_SEARCH_ENDPOINT=$azureSearchEndpoint"
# Add-Content -Path $envFilePath -Value "AZURE_SEARCH_INDEX=$azureSearchIndex"
# Add-Content -Path $envFilePath -Value "AZURE_SEARCH_SEMANTIC_CONFIGURATION=$azureSearchSemanticConfiguration"
# Add-Content -Path $envFilePath -Value "AZURE_SEARCH_IDENTIFIER_FIELD=$azureSearchIdentifierField"
# Add-Content -Path $envFilePath -Value "AZURE_SEARCH_TITLE_FIELD=$azureSearchTitleField"
# Add-Content -Path $envFilePath -Value "AZURE_SEARCH_CONTENT_FIELD=$azureSearchContentField"
# Add-Content -Path $envFilePath -Value "AZURE_SEARCH_EMBEDDING_FIELD=$azureSearchEmbeddingField"
# Add-Content -Path $envFilePath -Value "AZURE_SEARCH_USE_VECTOR_QUERY=$azureSearchUseVectorQuery"

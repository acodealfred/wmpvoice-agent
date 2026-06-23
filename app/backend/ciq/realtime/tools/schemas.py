"""Function-call JSON schemas advertised to the Azure OpenAI Realtime model."""

SENTIMENT_SCHEMA = {
    "type": "function",
    "name": "report_sentiment",
    "description": "Report the sentiment analysis result from the user's voice input. Use this tool to record the sentiment after analyzing the user's message. The sentiment should be either 'positive', 'neutral', or 'negative', along with a brief reason.",
    "parameters": {
        "type": "object",
        "properties": {
            "sentiment": {
                "type": "string",
                "enum": ["positive", "neutral", "negative"],
                "description": "The sentiment of the user's input",
            },
            "reason": {
                "type": "string",
                "description": "Brief explanation of why this sentiment was detected",
            },
        },
        "required": ["sentiment", "reason"],
        "additionalProperties": False,
    },
}

SURVEY_SCHEMA = {
    "type": "function",
    "name": "record_survey_response",
    "description": "Record the user's response to a burnout assessment question. Use Likert scale 1-5 where 1=Never, 2=Rarely, 3=Sometimes, 4=Often, 5=Always.",
    "parameters": {
        "type": "object",
        "properties": {
            "question_id": {
                "type": "string",
                "description": "The question identifier (e.g., q1, q2, q3, q4, q5)",
            },
            "score": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5,
                "description": "Likert score: 1=Never, 2=Rarely, 3=Sometimes, 4=Often, 5=Always",
            },
            "user_verbal_response": {
                "type": "string",
                "description": "The user's natural language response",
            },
            "voice_sentiment": {
                "type": "string",
                "enum": ["positive", "neutral", "negative"],
                "description": "Sentiment detected from user's voice",
            },
            "blink_rate_change_percent": {
                "type": "number",
                "description": "Percentage change in blink rate from baseline during this answer",
            },
            "face_emotion": {
                "type": "string",
                "description": "Dominant emotion detected from face (e.g., HAPPY, SAD, ANGRY, NEUTRAL)",
            },
        },
        "required": ["question_id", "score"],
        "additionalProperties": False,
    },
}

QUERY_SURVEY_SCHEMA = {
    "type": "function",
    "name": "query_survey_results",
    "description": "Query the survey results to answer user questions about their burnout assessment. Use this to provide insights about burnout score, contributing domains, stress indicators, specific question responses, and biometric readings (blink-rate change, gaze position). The 'summary' query type returns the biometric readings.",
    "parameters": {
        "type": "object",
        "properties": {
            "query_type": {
                "type": "string",
                "enum": ["burnout_score", "contributing_domains", "stress_questions", "domain_scores", "summary"],
                "description": "Type of query to perform on survey results",
            },
            "domain": {
                "type": "string",
                "description": "Specific domain to query (optional, for domain-specific questions)",
            },
        },
        "required": ["query_type"],
        "additionalProperties": False,
    },
}

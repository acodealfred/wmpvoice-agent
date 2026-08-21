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
    "description": (
        "Record the user's response to an assessment question. The valid score "
        "depends on the question: 'bat_'-prefixed questions use a 1-5 Likert scale "
        "(1=Never, 2=Rarely, 3=Sometimes, 4=Often, 5=Always); 'cbi_'-prefixed questions "
        "use a 0-100 scale (0=Never/Almost Never, 25=Seldom, 50=Sometimes, 75=Often, "
        "100=Always). Always use the exact scale explained to the user for the current "
        "question — never interpolate between values. For a qualitative, open-ended "
        "conversation (e.g. 'readiness_'-prefixed questions), the user is never asked "
        "for a number — silently classify how they came across as 1=Low, 3=Medium, or "
        "5=High and pass that as score (see the survey script for the exact rule)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "question_id": {
                "type": "string",
                "description": "The question identifier (e.g., q1, q2, q3, q4, q5)",
            },
            "score": {
                "type": "integer",
                "enum": [0, 1, 2, 3, 4, 5, 25, 50, 75, 100],
                "description": (
                    "For 1-5 scale questions: 1=Never, 2=Rarely, 3=Sometimes, 4=Often, 5=Always. "
                    "For 0-100 scale questions: 0=Never/Almost Never, 25=Seldom, 50=Sometimes, "
                    "75=Often, 100=Always. Omit entirely for a qualitative, open-ended question."
                ),
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
        "required": ["question_id"],
        "additionalProperties": False,
    },
}

QUERY_SURVEY_SCHEMA = {
    "type": "function",
    "name": "query_survey_results",
    "description": "Query the survey results to answer user questions about their burnout assessment. Use this to provide insights about burnout score, contributing domains, stress indicators, specific question responses, and biometric readings (blink-rate change, left/right eye-gaze position). The 'summary' query type returns the biometric readings.",
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

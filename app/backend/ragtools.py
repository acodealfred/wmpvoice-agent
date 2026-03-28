# RAG tools - Currently disabled
# This module is kept for future extensibility when RAG features need to be re-enabled.
# To re-enable:
# 1. Install azure-search-documents: pip install azure-search-documents==11.6.0b4
# 2. Uncomment the import and function calls in app.py
# 3. Set the AZURE_SEARCH_* environment variables

from rtmt import RTMiddleTier


def attach_rag_tools(rtmt: RTMiddleTier,
    credentials: any,
    search_endpoint: str,
    search_index: str,
    semantic_configuration: str | None,
    identifier_field: str,
    content_field: str,
    embedding_field: str,
    title_field: str,
    use_vector_query: bool
    ) -> None:
    """
    RAG tools are currently disabled.
    
    To re-enable in the future:
    - Install azure-search-documents package
    - Import and call the original implementation from a backup or VCS
    - Configure AZURE_SEARCH_* environment variables
    """
    # RAG features disabled - kept for future extensibility
    # The attach_rag_tools function would:
    # 1. Create a SearchClient to connect to Azure AI Search
    # 2. Register 'search' tool for knowledge base queries
    # 3. Register 'report_grounding' tool for source citations
    pass


# Legacy code backup (commented out for reference):
# 
# import re
# from typing import Any
# 
# from azure.core.credentials import AzureKeyCredential
# from azure.identity import DefaultAzureCredential
# from azure.search.documents.aio import SearchClient
# from azure.search.documents.models import VectorizableTextQuery
# 
# from rtmt import RTMiddleTier, Tool, ToolResult, ToolResultDirection
# 
# _search_tool_schema = {
#     "type": "function",
#     "name": "search",
#     "description": "Search the knowledge base. The knowledge base is in English, translate to and from English if " + \
#                    "needed. Results are formatted as a source name first in square brackets, followed by the text " + \
#                    "content, and a line with '-----' at the end of each result.",
#     "parameters": {
#         "type": "object",
#         "properties": {
#             "query": {
#                 "type": "string",
#                 "description": "Search query"
#             }
#         },
#         "required": ["query"],
#         "additionalProperties": False
#     }
# }
# 
# _grounding_tool_schema = {
#     "type": "function",
#     "name": "report_grounding",
#     "description": "Report use of a source from the knowledge base as part of an answer (effectively, cite the source). Sources " + \
#                    "appear in square brackets before each knowledge base passage. Always use this tool to cite sources when responding " + \
#                    "with information from the knowledge base.",
#     "parameters": {
#         "type": "object",
#         "properties": {
#             "sources": {
#                 "type": "array",
#                 "items": {
#                     "type": "string"
#                 },
#                 "description": "List of source names from last statement actually used, do not include the ones not used to formulate a response"
#             }
#         },
#         "required": ["sources"],
#         "additionalProperties": False
#     }
# }
# 
# async def _search_tool(
#     search_client: SearchClient, 
#     semantic_configuration: str | None,
#     identifier_field: str,
#     content_field: str,
#     embedding_field: str,
#     use_vector_query: bool,
#     args: Any) -> ToolResult:
#     print(f"Searching for '{args['query']}' in the knowledge base.")
#     # Hybrid query using Azure AI Search with (optional) Semantic Ranker
#     vector_queries = []
#     if use_vector_query:
#         vector_queries.append(VectorizableTextQuery(text=args['query'], k_nearest_neighbors=50, fields=embedding_field))
#     search_results = await search_client.search(
#         search_text=args["query"], 
#         query_type="semantic" if semantic_configuration else "simple",
#         semantic_configuration_name=semantic_configuration,
#         top=5,
#         vector_queries=vector_queries,
#         select=", ".join([identifier_field, content_field])
#     )
#     result = ""
#     async for r in search_results:
#         result += f"[{r[identifier_field]}]: {r[content_field]}\n-----\n"
#     return ToolResult(result, ToolResultDirection.TO_SERVER)
# 
# KEY_PATTERN = re.compile(r'^[a-zA-Z0-9_=\-]+$')
# 
# async def _report_grounding_tool(search_client: SearchClient, identifier_field: str, title_field: str, content_field: str, args: Any) -> None:
#     sources = [s for s in args["sources"] if KEY_PATTERN.match(s)]
#     list = " OR ".join(sources)
#     print(f"Grounding source: {list}")
#     search_results = await search_client.search(search_text=list, 
#                                                 search_fields=[identifier_field], 
#                                                 select=[identifier_field, title_field, content_field], 
#                                                 top=len(sources), 
#                                                 query_type="full")
#     docs = []
#     async for r in search_results:
#         docs.append({"chunk_id": r[identifier_field], "title": r[title_field], "chunk": r[content_field]})
#     return ToolResult({"sources": docs}, ToolResultDirection.TO_CLIENT)
# 
# def attach_rag_tools(rtmt: RTMiddleTier,
#     credentials: AzureKeyCredential | DefaultAzureCredential,
#     search_endpoint: str, search_index: str,
#     semantic_configuration: str | None,
#     identifier_field: str,
#     content_field: str,
#     embedding_field: str,
#     title_field: str,
#     use_vector_query: bool
#     ) -> None:
#     if not isinstance(credentials, AzureKeyCredential):
#         credentials.get_token("https://search.azure.com/.default")
#     search_client = SearchClient(search_endpoint, search_index, credentials, user_agent="RTMiddleTier")
# 
#     rtmt.tools["search"] = Tool(schema=_search_tool_schema, target=lambda args: _search_tool(search_client, semantic_configuration, identifier_field, content_field, embedding_field, use_vector_query, args))
#     rtmt.tools["report_grounding"] = Tool(schema=_grounding_tool_schema, target=lambda args: _report_grounding_tool(search_client, identifier_field, title_field, content_field, args))

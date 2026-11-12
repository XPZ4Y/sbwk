Ok, so this is what we do.

- A docker container, that takes inbound request and redirects request to server as normal. Like cloudflare.
- It also has access to other 3rd party servers, and databases that our servers use. Like auth server (google auth, mongodb auth); It acquires logs on the 3rd party servers too (the developer has to configure it.

- Noow then, A core agent is connected to our docker container.
- The docker container has a built in detector that detects abnormalities life 404, or 500 or anything.
- Therefore, once a abnormal request comes by, the dispatch is sent to core agent. MCP or something via API. And agent thinks and returns solution. THe agent first accesses external logs, finds errors. Then looks at the codebase. If error is found, it will suggest fix. 
- Agent retains context. If things don't work out, actual engineer is awoken.




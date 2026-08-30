INSERT INTO users (id, name, email) 
VALUES ('cbe3e959-1e3a-4ff1-a793-18e5e6e8c8a1', 'Test User', 'test@example.com');

INSERT INTO workspaces (id, name, description) 
VALUES ('11111111-1e3a-4ff1-a793-18e5e6e8c8a1', 'Test Workspace', 'Seed workspace');

INSERT INTO workspace_members (workspace_id, user_id, role)
VALUES ('11111111-1e3a-4ff1-a793-18e5e6e8c8a1', 'cbe3e959-1e3a-4ff1-a793-18e5e6e8c8a1', 'owner');

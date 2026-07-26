<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GUS Patch Editor</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 900px;
            margin: 40px auto;
            padding: 20px;
            background-color: #f8f9fa;
        }
        .container {
            background-color: #fff;
            padding: 25px 40px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.08);
            border: 1px solid #e9ecef;
        }
        h1, h2 {
            color: #212529;
            text-align: center;
            margin-bottom: 25px;
        }
        .project-list {
            list-style: none;
            padding: 0;
        }
        .project-item {
            background: #f9f9f9;
            border: 1px solid #ddd;
            padding: 15px;
            margin-bottom: 10px;
            border-radius: 5px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .project-item h3 {
            margin: 0;
            font-size: 1.2em;
        }
        .project-item .actions a {
            margin-left: 10px;
            text-decoration: none;
            padding: 5px 10px;
            border-radius: 4px;
            color: #fff;
        }
        .actions .edit-btn { background-color: #007bff; }
        .actions .download-btn { background-color: #28a745; }
        .new-project-box {
            margin-top: 30px;
            padding: 20px;
            border: 1px solid #ccc;
            border-radius: 5px;
            background: #fdfdfd;
        }
        #new-project-name {
            width: calc(100% - 100px);
            padding: 8px;
            border-radius: 4px;
            border: 1px solid #ccc;
        }
        #btn-create-project {
            width: 90px;
            padding: 9px;
            border: none;
            background-color: #17a2b8;
            color: white;
            border-radius: 4px;
            cursor: pointer;
        }
    </style>
</head>
<body>

    <div class="container">
        <h1>GUS Patch Editor</h1>

        <div id="projects-container">
            <h2>My Projects</h2>
            <ul id="project-list" class="project-list">
                <!-- Projects will be loaded here by JavaScript -->
            </ul>
        </div>

        <div class="new-project-box">
            <h3>Create New Project</h3>
            <input type="text" id="new-project-name" placeholder="Enter project name" required>
            <button id="btn-create-project">Create</button>
        </div>
    </div>

    <script>
        document.addEventListener('DOMContentLoaded', function() {
            const projectList = document.getElementById('project-list');
            const btnCreate = document.getElementById('btn-create-project');
            const newProjectNameInput = document.getElementById('new-project-name');

            async function fetchProjects() {
                try {
                    const response = await fetch('api/editor.php?action=list_projects');
                    const projects = await response.json();
                    projectList.innerHTML = ''; // Clear list

                    if (projects.length === 0) {
                        projectList.innerHTML = '<li>No projects found. Create one below!</li>';
                    } else {
                        projects.forEach(proj => {
                            const li = document.createElement('li');
                            li.className = 'project-item';
                            li.innerHTML = `
                                <div>
                                    <h3>${escapeHtml(proj.name)}</h3>
                                    <small>Created: ${new Date(proj.created_at).toLocaleString()}</small>
                                </div>
                                <div class="actions">
                                    <a href="edit-project.php?id=${proj.id}" class="edit-btn">Edit</a>
                                    <a href="api/editor.php?action=download_project&project_id=${proj.id}" class="download-btn">Download ZIP</a>
                                </div>
                            `;
                            projectList.appendChild(li);
                        });
                    }
                } catch (error) {
                    console.error('Error:', error);
                    projectList.innerHTML = '<li>Error loading projects.</li>';
                }
            }

            async function createProject() {
                const name = newProjectNameInput.value.trim();
                if (!name) {
                    alert('Project name is required.');
                    return;
                }

                try {
                    const response = await fetch('api/editor.php?action=create_project', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: name })
                    });
                    const result = await response.json();
                    if (result.success) {
                        newProjectNameInput.value = '';
                        fetchProjects(); // Refresh the list
                    } else {
                        alert('Error: ' + (result.error || 'Could not create project.'));
                    }
                } catch (error) {
                    alert('An error occurred while creating the project.');
                }
            }

            function escapeHtml(unsafe) {
                return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
            }

            btnCreate.addEventListener('click', createProject);
            newProjectNameInput.addEventListener('keyup', (event) => {
                if (event.key === 'Enter') {
                    createProject();
                }
            });

            fetchProjects(); // Initial load
        });
    </script>

</body>
</html>
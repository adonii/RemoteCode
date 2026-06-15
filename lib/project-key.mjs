export function buildProjectKey(machineName, projectFolder) {
  return `${machineName}__${projectFolder}`;
}

export function parseProjectKey(projectKey) {
  const index = projectKey.indexOf('__');
  if (index <= 0) {
    return null;
  }

  return {
    machineName: projectKey.slice(0, index),
    projectFolder: projectKey.slice(index + 2),
  };
}

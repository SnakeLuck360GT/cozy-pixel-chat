// JSON API calls. A 401 means the session ended, so go to the login page.

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/login") {
    toLogin();
    return new Promise(() => {});
  }
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

export function toLogin() {
  const here = location.pathname + location.hash;
  location.href = here === "/" ? "/login" : `/login?next=${encodeURIComponent(here)}`;
}

// Uploads one file with progress. Fields go first so the server has them
// before the file arrives. Returns { done: Promise, abort() }.
export function upload(file, { purpose = "attachment", fields = {}, name, onProgress, query = "" } = {}) {
  const xhr = new XMLHttpRequest();
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append("file", file, name ?? file.name ?? "file");
  const done = new Promise((resolve, reject) => {
    xhr.open("POST", `/upload?purpose=${purpose}${query}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status === 401) toLogin();
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || "Upload failed"));
    };
    xhr.onerror = () => reject(new Error("Upload failed. Check your connection."));
    xhr.onabort = () => reject(new Error("Cancelled"));
    xhr.send(form);
  });
  return { done, abort: () => xhr.abort() };
}

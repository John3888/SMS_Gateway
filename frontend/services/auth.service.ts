export async function login(username: string, password: string) {
  const response = await fetch("/admin-api/authentication/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (response.status === 401) throw new Error("Incorrect username or password.");
  if (response.status === 429) throw new Error("Too many attempts. Try again in a minute.");
  if (!response.ok) throw new Error("Gateway unavailable (" + response.status + ").");
}

export async function logout() {
  const response = await fetch("/admin-api/authentication/logout", { method: "POST" });
  if (!response.ok && response.status !== 401) throw new Error("Sign-out failed. Please try again.");
}

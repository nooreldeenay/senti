export function getUserId(): string {
  if (typeof window === 'undefined') return '';
  
  let userId = localStorage.getItem('senti_user_id');
  if (!userId) {
    userId = `user_${Math.random().toString(36).substring(2, 15)}_${Date.now()}`;
    localStorage.setItem('senti_user_id', userId);
  }
  return userId;
}

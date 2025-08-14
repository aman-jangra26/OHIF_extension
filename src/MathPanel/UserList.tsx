import React from 'react';

export default function UserList({ users }) {
  return (
    <div>
      <h4>Participants</h4>
      <ul>
        {users.map(u => (
          <li key={u.id}>{u.name}</li>
        ))}
      </ul>
    </div>
  );
}

import { Entity, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { Post } from "./Post.js";
import { User } from "./User.js";

@Entity({ tableName: "post_likes" })
@Unique({ properties: ["post", "user"] })
export class PostLike {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => Post, { deleteRule: "cascade" })
  post!: Post;

  @ManyToOne(() => User, { deleteRule: "cascade" })
  user!: User;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();
}

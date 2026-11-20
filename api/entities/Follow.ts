import { Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { User } from "./User.js";

@Entity({ tableName: "follows" })
@Unique({ properties: ["follower", "followee"] })
@Index({ properties: ["followee"] })
export class Follow {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @ManyToOne(() => User, { deleteRule: "cascade" })
  follower!: User;

  @ManyToOne(() => User, { deleteRule: "cascade" })
  followee!: User;

  @Property({ type: "timestamptz", onCreate: () => new Date() })
  createdAt: Date = new Date();
}
